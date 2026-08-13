import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { assertAuthorizedPath, WritingService } from "@writing-mcp/core";
import { GenericAdapter } from "@writing-mcp/adapter-generic";

describe("M1 authorized path boundary",()=>{
  test("requires configured roots and rejects source paths outside them",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-root-"));const outside=await mkdtemp(join(tmpdir(),"writing-mcp-outside-"));
    try{await expect(assertAuthorizedPath(root,[])).rejects.toMatchObject({code:"AUTHORIZED_ROOTS_REQUIRED"});await expect(assertAuthorizedPath(outside,[root])).rejects.toMatchObject({code:"PATH_NOT_ALLOWED"});await expect(assertAuthorizedPath(root,[root])).resolves.toBeTruthy();}
    finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });

  test("rejects a directory symlink or junction that escapes the selected work",async()=>{
    const root=await mkdtemp(join(tmpdir(),"writing-mcp-root-"));const work=join(root,"novel");const outside=await mkdtemp(join(tmpdir(),"writing-mcp-outside-"));await mkdir(work);await writeFile(join(work,"chapter.md"),"# 第一章\n安全内容");await writeFile(join(outside,"secret.md"),"# 外部文本\n不得读取");
    try{await symlink(outside,join(work,"escaped"),process.platform==="win32"?"junction":"dir");const adapter=new GenericAdapter();await expect(adapter.discover(work)).resolves.toEqual([]);}
    finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });

  test("service enforces roots before adapter discovery",async()=>{
    const allowed=await mkdtemp(join(tmpdir(),"writing-mcp-allowed-"));const outside=await mkdtemp(join(tmpdir(),"writing-mcp-outside-"));await writeFile(join(outside,"novel.md"),"# Novel\nText");const service=new WritingService([new GenericAdapter()],[allowed]);
    try{await expect(service.resolve(outside)).rejects.toMatchObject({code:"PATH_NOT_ALLOWED"});}
    finally{service.close();await rm(allowed,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});
