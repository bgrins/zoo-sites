// Regenerate the compose service block for the_zoo from the manifest, so the
// domain list can never drift from what the container actually serves.
//   node docker/gen-zoo-snippet.mjs > docker/zoo-snippet.yaml
//
// The image owner comes from the environment so a fork regenerates its own
// image name rather than this repo's: .github/workflows/container.yml publishes
// to ghcr.io/<repository owner>/zoo-sites, and GITHUB_REPOSITORY_OWNER is set
// for you inside Actions.
import { zooDomainsLabel } from '../manifest.mjs';

const owner = process.env.GITHUB_REPOSITORY_OWNER ?? '<owner>';

console.log(`  zoo-sites:
    image: ghcr.io/${owner}/zoo-sites:latest
    restart: unless-stopped
    labels:
      zoo.domains: ${zooDomainsLabel()}`);
