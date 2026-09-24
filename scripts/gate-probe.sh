#!/usr/bin/env bash
set -u
JELLINO_URL="${1:?usage: gate-probe.sh <workers-url> <username> <password> [outdir]}"
JELLINO_USER="${2:?usage: gate-probe.sh <workers-url> <username> <password> [outdir]}"
JELLINO_PASS="${3:?usage: gate-probe.sh <workers-url> <username> <password> [outdir]}"
OUT="${4:-gate-logs}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$OUT/gate-$STAMP.log"
: > "$LOG"
PASS=0
FAIL=0
SKIPPED=0
note() {
  echo "$*" | tee -a "$LOG"
}
record() {
  echo "$1 $2 -> $3" >> "$LOG"
  if [ "$3" = "$4" ]; then
    PASS=$((PASS + 1))
    note "PASS $1 $2 -> $3"
  else
    FAIL=$((FAIL + 1))
    note "FAIL $1 $2 -> $3 (wanted $4)"
  fi
}
skip() {
  SKIPPED=$((SKIPPED + 1))
  note "SKIP $1 $2 ($3)"
  echo "SKIP $1 $2 ($3)" >> "$LOG"
}
probe() {
  method="$1"
  path="$2"
  want="$3"
  shift 3
  body_file="$OUT/body-$STAMP.tmp"
  if [ "$method" = "GET" ]; then
    code="$(curl -s -o "$body_file" -w "%{http_code}" "$JELLINO_URL$path" "$@" || true)"
  else
    code="$(curl -s -o "$body_file" -w "%{http_code}" -X "$method" "$JELLINO_URL$path" "$@" || true)"
  fi
  record "$method" "$path" "$code" "$want"
}
json() {
  python3 -c "import json,sys; print(json.load(open('$OUT/body-$STAMP.tmp'))$1)"
}
note "Jellino release gate probe $STAMP against $JELLINO_URL as $JELLINO_USER"
probe GET "/System/Info/Public" 200
probe GET "/System/Ping" 200
curl -s -o "$OUT/body-$STAMP.tmp" -w "%{http_code}" -o /dev/null "$JELLINO_URL/System/Info/Public" > /dev/null 2>&1 || true
AUTH_BODY="{\"Username\":\"$JELLINO_USER\",\"Pw\":\"$JELLINO_PASS\"}"
code="$(curl -s -o "$OUT/body-$STAMP.tmp" -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$AUTH_BODY" "$JELLINO_URL/Users/AuthenticateByName" || true)"
record POST "/Users/AuthenticateByName" "$code" 200
if [ "$code" != "200" ]; then
  note "Login failed, cannot continue the authenticated sequence."
  note "Result: PASS=$PASS FAIL=$FAIL SKIPPED=$SKIPPED log=$LOG"
  exit 1
fi
TOKEN="$(json "['AccessToken']")"
USERID="$(json "['User']['Id']")"
note "Logged in as $USERID"
EMBY="X-Emby-Authorization: MediaBrowser Client=\"gate\", Token=\"$TOKEN\""
probe GET "/Users/Me" 200 -H "$EMBY"
probe GET "/Users/Me" 200 -H "Authorization: MediaBrowser Token=\"$TOKEN\""
probe GET "/Users/Me" 200 -H "X-Emby-Token: $TOKEN"
probe GET "/Users/Me?api_key=$TOKEN" 200
probe GET "/Users/$USERID/Views" 200 -H "$EMBY"
probe GET "/UserViews?userId=$USERID" 200 -H "$EMBY"
probe GET "/Library/MediaFolders?userId=$USERID" 200 -H "$EMBY"
probe GET "/Library/VirtualFolders?userId=$USERID" 200 -H "$EMBY"
probe GET "/Users/$USERID/Items/Latest" 200 -H "$EMBY"
probe GET "/Items/Latest?userId=$USERID" 200 -H "$EMBY"
probe GET "/Users/$USERID/Items?searchTerm=gate" 200 -H "$EMBY"
probe GET "/Search/Hints?searchTerm=gate&userId=$USERID" 200 -H "$EMBY"
ITEM="$(json "['SearchHints'][0]['Id']" 2>/dev/null || echo "")"
if [ -z "$ITEM" ]; then
  ITEM="$(python3 -c "import json; d=json.load(open('$OUT/body-$STAMP.tmp')); print((d.get('Items') or [{}])[0].get('Id',''))" 2>/dev/null || echo "")"
fi
probe GET "/Users/$USERID/Items/Resume" 200 -H "$EMBY"
probe GET "/Shows/NextUp?userId=$USERID" 200 -H "$EMBY"
probe GET "/DisplayPreferences/homesection?userId=$USERID&client=gate" 200 -H "$EMBY"
if [ -z "$ITEM" ]; then
  skip POST "/Items/{id}/PlaybackInfo" "library empty, nothing playable"
  skip GET "/Videos/{id}/stream" "library empty, nothing playable"
  skip POST "/Sessions/Playing" "library empty, nothing playable"
else
  note "Probing playback with item $ITEM"
  probe GET "/Users/$USERID/Items/$ITEM" 200 -H "$EMBY"
  probe POST "/Users/$USERID/Items/$ITEM/PlaybackInfo" 200 -H "$EMBY" -H "Content-Type: application/json" -d "{\"UserId\":\"$USERID\"}"
  probe GET "/Items/$ITEM/PlaybackInfo?UserId=$USERID" 200 -H "$EMBY"
  vcode="$(curl -s -o /dev/null -w "%{http_code}" "$JELLINO_URL/Videos/$ITEM/stream.mp4?api_key=$TOKEN" || true)"
  record GET "/Videos/$ITEM/stream.mp4" "$vcode" 302
  play_body="{\"ItemId\":\"$ITEM\"}"
  probe POST "/Sessions/Playing" 200 -H "$EMBY" -H "Content-Type: application/json" -d "$play_body"
  probe POST "/Sessions/Playing/Progress" 200 -H "$EMBY" -H "Content-Type: application/json" -d "{\"ItemId\":\"$ITEM\",\"PositionTicks\":600000000}"
  probe POST "/Sessions/Playing/Stopped" 200 -H "$EMBY" -H "Content-Type: application/json" -d "{\"ItemId\":\"$ITEM\",\"PositionTicks\":600000000}"
  probe POST "/Sessions/Logout" 204 -H "$EMBY"
fi
note "Tolerated probes, any code except 500 passes:"
for probe_path in "/LiveTv/Programs" "/Moonfin/ping" "/socket" "/System/Configuration/Encoding"; do
  tcode="$(curl -s -o /dev/null -w "%{http_code}" "$JELLINO_URL$probe_path" || true)"
  echo "TOLERATED $probe_path -> $tcode" >> "$LOG"
  if [ "$tcode" = "500" ]; then
    FAIL=$((FAIL + 1))
    note "FAIL tolerated $probe_path -> 500"
  else
    PASS=$((PASS + 1))
    note "PASS tolerated $probe_path -> $tcode"
  fi
done
note "Result: PASS=$PASS FAIL=$FAIL SKIPPED=$SKIPPED log=$LOG"
if [ "$FAIL" != "0" ]; then
  exit 1
fi
