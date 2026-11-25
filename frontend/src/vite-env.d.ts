/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Bellandur pilot bounds in west,south,east,north order. */
  readonly VITE_PILOT_BBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
