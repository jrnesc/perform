import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredScopes } from "../live/capabilities";
import { performOAuthScopes } from "./oauth-scopes";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("requested OAuth scopes", () => {
  it("are the same in the manifest, .env.example and code", () => {
    const manifest = JSON.parse(read("public/app-manifest.json")) as { oauth: { scopes: string[] } };
    const env = /^OAUTH_SCOPES=(.*)$/m.exec(read(".env.example"))?.[1].split(/\s+/);
    expect(manifest.oauth.scopes).toEqual([...performOAuthScopes]);
    expect(env).toEqual([...performOAuthScopes]);
  });

  it("cover every live capability", () => {
    for (const scopes of Object.values(requiredScopes)) {
      for (const scope of scopes) expect(performOAuthScopes).toContain(scope);
    }
  });
});
