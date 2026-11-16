import { describe, expect, it } from "vitest";

describe("observabilityConnectionString", () => {
  it("garde la même base et les mêmes paramètres, avec un nom d'application à part", async () => {
    process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/x";
    const { observabilityConnectionString } = await import("../src/mastra/index.js");
    const neon = "postgresql://u:p%40ss@ep-x.eu-central-1.aws.neon.tech/aecbot?sslmode=verify-full&channel_binding=require";
    const out = new URL(observabilityConnectionString(neon));
    expect(out.host).toBe("ep-x.eu-central-1.aws.neon.tech");
    expect(out.pathname).toBe("/aecbot");
    expect(out.password).toBe("p%40ss");
    expect(out.searchParams.get("sslmode")).toBe("verify-full");
    expect(out.searchParams.get("channel_binding")).toBe("require");
    expect(out.searchParams.get("application_name")).toBe("aecbot-observability");
    expect(observabilityConnectionString("postgresql://u:p@localhost:5432/x")).not.toBe("postgresql://u:p@localhost:5432/x");
  });
});
