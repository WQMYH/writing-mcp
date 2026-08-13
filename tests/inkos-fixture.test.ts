import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { InkosAdapter } from "@writing-mcp/adapter-inkos";

describe("M0 minimal InkOS fixture",()=>{
  test("resolves one stable work and maps native document kinds",async()=>{
    const source=fileURLToPath(new URL("../fixtures/inkos-minimal",import.meta.url));const adapter=new InkosAdapter();
    const first=await adapter.discover(source);const second=await adapter.discover(source);
    expect(first).toHaveLength(1);expect(first[0]?.workRef).toBe(second[0]?.workRef);expect(first[0]?.title).toBe("塔影");
    const work=await adapter.load(first[0]!);expect(work.documents.map(d=>d.kind).sort()).toEqual(["chapter","character","foreshadow","outline","state"]);expect(work.documents.find(d=>d.kind==="chapter")?.chapterNumber).toBe(1);expect(new Set(work.documents.map(d=>d.documentRef)).size).toBe(work.documents.length);
  });
});
