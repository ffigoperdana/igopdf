// Keep the production merge worker filename tied to the UI build. A browser
// tab can remain controlled by an older service worker after a deployment;
// using a build-specific URL prevents it from pairing old worker bytes with a
// new merge message shape.
export const MERGE_WORKER_URL = import.meta.env.DEV
  ? `${import.meta.env.BASE_URL}workers/merge.worker.js`
  : `${import.meta.env.BASE_URL}workers/merge.worker-${__IGO_BUILD_ID__}.js`;
