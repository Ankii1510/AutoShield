import next from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next 16 ships flat config arrays directly, so they are spread
// here rather than wrapped in FlatCompat (which cannot load them).
const config = [
  ...next,
  ...nextCoreWebVitals,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default config;
