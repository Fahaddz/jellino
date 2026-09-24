import { beforeEach } from "vitest";
import { resetManifestMemory } from "../src/library";
import { resetCatalogStrides } from "../src/catalog-page";
import { resetInFlight } from "../src/cache";
import { resetFailureLogThrottle } from "../src/applog";
import { resetNuvioWatchState } from "../src/nuvio-home";

beforeEach(() => {
  resetManifestMemory();
  resetCatalogStrides();
  resetInFlight();
  resetFailureLogThrottle();
  resetNuvioWatchState();
});
