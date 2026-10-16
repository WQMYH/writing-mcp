import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { GenericAdapter } from "@writing-mcp/adapter-generic";
import { WritingService, WritingStore } from "@writing-mcp/core";

async function fixtureZip(options:{container?:boolean;opf?:boolean;chapters?:boolean}={container:true,opf:true,chapters:true}){
  const zip=new JSZip();const base=new URL("../fixtures/epub-minimal/",import.meta.url);
  if(options.container)zip.file("META-INF/container.xml",await readFile(new URL("META-INF/container.xml",base),"utf8"));
  if(options.opf)zip.file("OEBPS/content.opf",await readFile(new URL("OEBPS/content.opf",base),"utf8"));
  if(options.chapters){zip.file("OEBPS/chapter-1.xhtml",await readFile(new URL("OEBPS/chapter-1.xhtml",base),"utf8"));zip.file("OEBPS/chapter-2.xhtml",await readFile(new URL("OEBPS/chapter-2.xhtml",base),"utf8"));}
  return zip.generateAsync({type:"nodebuffer"});
}

async function convertedBookFixture(){
  const zip=new JSZip(),title="\u67ab\u9701";
  zip.file("META-INF/container.xml",`<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="content.opf"/></rootfiles></container>`);
  zip.file("content.opf",`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title></metadata><manifest><item href="titlepage.xhtml" id="cover" media-type="application/xhtml+xml"/><item href="part-1.html" id="part-1" media-type="application/xhtml+xml"/><item href="part-2.html" id="part-2" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="part-1"/><itemref idref="part-2"/></spine></package>`);
  zip.file("titlepage.xhtml",`<html><head><title>Cover</title></head><body>Cover</body></html>`);
  zip.file("part-1.html",`<html><head><title>\ufffd\ufffd\ufffd\ufffd</title></head><body><p>《${title}》</p><p>（上）</p><p>第一章</p><p>秦晴在雨中出现。</p><p>第二章</p><p>阿枫开始奔跑。</p></body></html>`);
  zip.file("part-2.html",`<html><head><title>broken</title></head><body><p>第二章的后半部分。</p><p>第三章</p><p>方宏留下钥匙。</p></body></html>`);
  return zip.generateAsync({type:"nodebuffer"});
}

describe("generic EPUB technical validation",()=>{
  test.each([
    { name: "W011 literal named entities", html: "<p>&amp;lt;tag&amp;gt;</p>", want: "&lt;tag&gt;" },
    { name: "W011 literal decimal entities", html: "<p>&#38;lt;tag&#38;gt;</p>", want: "&lt;tag&gt;" },
    { name: "W011 literal hex entities", html: "<p>&#x26;lt;tag&#x26;gt;</p>", want: "&lt;tag&gt;" },
    { name: "W011 basic named control", html: "<p>&lt;tag&gt; &amp; &quot;quoted&quot; &apos;apostrophe&apos; A&nbsp;B</p>", want: '<tag> & "quoted" \'apostrophe\' A B' },
    { name: "W011 numeric Unicode control", html: "<p>&#60;tag&#x3e; &#128512; &#x20000;</p>", want: "<tag> 😀 𠀀" },
    { name: "W011 one amp layer control", html: "<p>&amp;amp;</p>", want: "&amp;" },
    { name: "W011 uppercase literal", html: "<p>&AMP;LT;</p>", want: "&LT;" },
    { name: "W011 unknown entity control", html: "<p>&mystery; &#notnumber;</p>", want: "&mystery; &#notnumber;" },
    { name: "W011 metadata entities", html: "<p>Body.</p>", want: "Body.", metadataTitle: "&amp;lt;archive&amp;gt;", wantTitle: "&lt;archive&gt;" },
    { name: "W016 plain break control", html: "<p>Alpha<br/>Beta</p>", want: "Alpha\nBeta" },
    { name: "W016 double-quoted break", html: '<p>Alpha<br class="scene"/>Beta</p>', want: "Alpha\nBeta" },
    { name: "W016 single-quoted break", html: "<p>Alpha<br class='scene' />Beta</p>", want: "Alpha\nBeta" },
    { name: "W016 multiline break", html: '<p>Alpha<br\nclass="scene" />Beta</p>', want: "Alpha\nBeta" },
    { name: "W016/W020 quoted greater-than break", html: '<p>Alpha<br title="a > b" />Beta</p>', want: "Alpha\nBeta" },
    { name: "W020 double-quoted tag", html: '<p title="a > b">Alpha</p>', want: "Alpha" },
    { name: "W020 single-quoted tag", html: "<p title='a > b'>Alpha</p>", want: "Alpha" },
    { name: "W020 quoted body", html: "<p>Alpha</p>", bodyAttributes: 'data-note="a > b"', want: "Alpha" },
    { name: "W020 quoted heading", html: '<h1 title="a > b">Title</h1><p>Alpha</p>', want: "Title\nAlpha", wantTitle: "Title" },
    { name: "W020 quoted metadata title", html: "<p>Alpha</p>", metadataAttributes: 'data-note="a > b"', metadataTitle: "Archive", want: "Alpha", wantTitle: "Archive" },
    { name: "W020 nested quoted tags", html: '<p><span title="a > b">Alpha</span><em title=\'c > d\'>Beta</em></p>', want: "AlphaBeta" },
    { name: "W020 filtered-content control", html: '<script title="a > b">bad</script><style title="a > b">bad</style><nav title="a > b">bad</nav><p>Alpha</p>', want: "Alpha" },
  ])("preserves body text: $name", async ({ html, want, bodyAttributes, metadataTitle, metadataAttributes, wantTitle }) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-text-")), path = join(dir, "fidelity.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title ${metadataAttributes ?? ""}>${metadataTitle ?? "Fidelity"}</dc:title></metadata><manifest><item id="one" href="chapter-1.xhtml"/></manifest><spine><itemref idref="one"/></spine></package>`);
    zip.file("OEBPS/chapter-1.xhtml", `<html><head><title>Ignored head</title></head><body ${bodyAttributes ?? ""}>${html}</body></html>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents).toHaveLength(1);
      expect(work.documents[0]!.content).toBe(want);
      if (wantTitle) expect(metadataTitle ? work.title : work.documents[0]!.title).toBe(wantTitle);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test.each(["&#x110000;", "&#55296;", "&#0;"])("rejects an invalid numeric text reference %s instead of publishing damaged text (W011)", async entity => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-bad-text-")), path = join(dir, "invalid.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/chapter-1.xhtml", `<html><body><p>${entity}</p></body></html>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try { await expect(adapter.load((await adapter.discover(path))[0]!)).rejects.toMatchObject({ code: "EPUB_TEXT_INVALID" }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  test.each([
    { tag: "h1", glyph: "😀" }, { tag: "p", glyph: "😀" },
    { tag: "h1", glyph: "𠀀" }, { tag: "p", glyph: "𠀀" },
  ])("keeps $glyph intact at the $tag fallback-title boundary (W-MCP-002)", async ({ tag, glyph }) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-unicode-title-")), path = join(dir, "title.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", '<package><manifest><item id="one" href="chapter-1.xhtml"/></manifest><spine><itemref idref="one"/></spine></package>');
    zip.file("OEBPS/chapter-1.xhtml", `<html><body><${tag}>${"T".repeat(99)}${glyph}title</${tag}></body></html>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try {
      const work = await adapter.load((await adapter.discover(path))[0]!);
      expect(work.documents).toHaveLength(1);
      expect(work.documents[0]!.title.isWellFormed()).toBe(true);
      expect(work.documents[0]!.title).toBe("T".repeat(99));
      expect(work.documents[0]!.content).toContain(glyph + "title");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test.each([
    { name: "percent ampersand", attributes: 'href="part%262.xhtml"', entry: "part&2.xhtml" },
    { name: "XML ampersand", attributes: 'href="part&amp;2.xhtml"', entry: "part&2.xhtml" },
    { name: "decimal ampersand", attributes: 'href="part&#38;2.xhtml"', entry: "part&2.xhtml" },
    { name: "hex ampersand", attributes: 'href="part&#x26;2.xhtml"', entry: "part&2.xhtml" },
    { name: "percent apostrophe", attributes: 'href="part%272.xhtml"', entry: "part'2.xhtml" },
    { name: "literal apostrophe", attributes: 'href="part\'2.xhtml"', entry: "part'2.xhtml" },
    { name: "literal double quote", attributes: `href='part"2.xhtml'`, entry: 'part"2.xhtml' },
    { name: "quoted greater-than", attributes: 'title="a > b" href="part&amp;2.xhtml"', entry: "part&2.xhtml" },
    { name: "single-pass entity", attributes: 'href="part&amp;lt;2.xhtml"', entry: "part&lt;2.xhtml" },
    { name: "href text inside another attribute", attributes: `title='href="wrong.xhtml"' href="part%262.xhtml"`, entry: "part&2.xhtml" },
  ])("retains both chapters for $name (W-MCP-014)", async ({ attributes, entry }) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-href-")), path = join(dir, "href.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", `<package><manifest><item id="first" href="chapter-1.xhtml"/><item id="second" ${attributes}/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>`);
    zip.file(`OEBPS/${entry}`, "<html><body><h1>第二章 星图</h1><p>星图钥匙藏在井底。</p></body></html>");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter(), service = new WritingService([adapter]);
    try {
      const [candidate] = await adapter.discover(path), work = await adapter.load(candidate!);
      expect(work.documents.map(doc => doc.title)).toEqual(["第一章 北塔", "第二章 星图"]);
      expect(work.documents[1]!.sourceSegments?.map(segment => segment.relativePath)).toEqual([`href.epub#OEBPS/${entry}`]);
      const { workRef } = await service.resolve(path);
      expect((await service.index(workRef!, "rebuild")).freshness).toBe("fresh");
      const found = await service.explore(workRef!, "search", "星图钥匙", 10, 0);
      expect(found.results[0]?.evidence.excerpt).toContain("星图钥匙");
      expect(found.results[0]?.evidence.locators?.[0]?.relativePath).toBe(`href.epub#OEBPS/${entry}`);
      const packet = await service.context(workRef!, "星图钥匙", 2000);
      expect(packet.blocks.some(block => block.evidence.excerpt.includes("星图钥匙"))).toBe(true);
    } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test.each([
    { name: "undeclared spine item", manifest: "", reference: '<itemref idref="second"/>', code: "EPUB_SPINE_ITEM_MISSING" },
    { name: "missing href", manifest: '<item id="second"/>', reference: '<itemref idref="second"/>', code: "EPUB_SPINE_ITEM_MISSING" },
    { name: "missing idref", manifest: "", reference: "<itemref/>", code: "EPUB_SPINE_ITEM_MISSING" },
    { name: "missing ZIP resource", manifest: '<item id="second" href="absent.xhtml"/>', reference: '<itemref idref="second"/>', code: "EPUB_SPINE_RESOURCE_MISSING" },
  ])("rejects $name after a readable chapter instead of returning partial fresh (W-MCP-014)", async ({ manifest, reference, code }) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-incomplete-")), path = join(dir, "incomplete.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", `<package><manifest><item id="first" href="chapter-1.xhtml"/>${manifest}</manifest><spine><itemref idref="first"/>${reference}</spine></package>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const service = new WritingService([new GenericAdapter()]);
    try {
      const { workRef } = await service.resolve(path);
      await expect(service.index(workRef!, "rebuild")).rejects.toMatchObject({ code });
    } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test("decodes container paths and spine ids using quoted XML attributes (W-MCP-014)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-package-")), path = join(dir, "package.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.remove("OEBPS/content.opf");
    zip.file("META-INF/container.xml", '<container><rootfiles><rootfile title="a > b" full-path="OEBPS/book&apos;&amp;.opf"/></rootfiles></container>');
    zip.file("OEBPS/book'&.opf", '<package><manifest><item id="first" href="chapter-1.xhtml"/><item id="sec&#111;nd" href="chapter-2.xhtml"/></manifest><spine><itemref idref="first"/><itemref title="a > b" idref="sec&#x6f;nd"/></spine></package>');
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try { expect((await adapter.load((await adapter.discover(path))[0]!)).documents.map(doc => doc.title)).toEqual(["第一章 北塔", "第二章 档案室"]); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  test.each([
    { href: "bad%GG.xhtml", code: "EPUB_HREF_INVALID" },
    { href: "%2e%2e/%2e%2e/outside.xhtml", code: "EPUB_HREF_INVALID" },
    { href: "bad&#x110000;.xhtml", code: "EPUB_ATTRIBUTE_INVALID" },
    { href: "bad&#55296;.xhtml", code: "EPUB_ATTRIBUTE_INVALID" },
    { href: "bad&#0;.xhtml", code: "EPUB_ATTRIBUTE_INVALID" },
  ])("keeps href validation for $href (W-MCP-014)", async ({ href, code }) => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-invalid-href-")), path = join(dir, "invalid.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", `<package><manifest><item id="bad" href="${href}"/></manifest><spine><itemref idref="bad"/></spine></package>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try { await expect(adapter.load((await adapter.discover(path))[0]!)).rejects.toMatchObject({ code }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("preserves intentional non-linear, navigation, cover and empty-content filtering (W-MCP-014)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-mcp-epub-filter-")), path = join(dir, "filtered.epub");
    const zip = await JSZip.loadAsync(await fixtureZip());
    zip.file("OEBPS/content.opf", '<package><manifest><item id="cover" href="cover.xhtml"/><item id="nav" href="nav.xhtml" properties="nav"/><item id="empty" href="empty.xhtml"/><item id="first" href="chapter-1.xhtml"/></manifest><spine><itemref linear="no"/><itemref idref="absent" linear="no"/><itemref idref="cover"/><itemref idref="nav"/><itemref idref="empty"/><itemref idref="first"/></spine></package>');
    zip.file("OEBPS/cover.xhtml", "<html><body>Cover</body></html>");
    zip.file("OEBPS/nav.xhtml", "<html><body>Contents</body></html>");
    zip.file("OEBPS/empty.xhtml", "");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const adapter = new GenericAdapter();
    try {
      const candidate = (await adapter.discover(path))[0]!;
      expect((await adapter.load(candidate)).documents.map(doc => doc.title)).toEqual(["第一章 北塔"]);
      zip.file("OEBPS/chapter-1.xhtml", "<html><body></body></html>");
      await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(adapter.load(candidate)).rejects.toMatchObject({ code: "EPUB_NO_READABLE_SPINE" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("loads ordered spine chapters with stable evidence locations",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-"));const path=join(dir,"tower.epub");await writeFile(path,await fixtureZip());const adapter=new GenericAdapter();
    try{const [candidate]=await adapter.discover(path);expect(candidate).toBeDefined();const work=await adapter.load(candidate!);expect(work.documents.map(d=>d.title)).toEqual(["第一章 北塔","第二章 档案室"]);expect(work.documents[0]?.relativePath).toContain("tower.epub#OEBPS/chapter-1.xhtml");}
    finally{await rm(dir,{recursive:true,force:true});}
  });

  test("uses OPF metadata and splits converted multi-chapter spine documents",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-converted-")),path=join(dir,"unknown.epub");await writeFile(path,await convertedBookFixture());const adapter=new GenericAdapter();
    try{
      const [candidate]=await adapter.discover(path);expect(candidate?.title).toBe("\u67ab\u9701");
      const work=await adapter.load(candidate!);
      expect(work.documents.map(document=>[document.kind,document.title])).toEqual([
        ["document","\u67ab\u9701 preface"],
        ["chapter","\u7b2c\u4e00\u7ae0"],
        ["chapter","\u7b2c\u4e8c\u7ae0"],
        ["chapter","\u7b2c\u4e09\u7ae0"],
      ]);
      expect(work.documents.some(document=>document.content.includes("Cover")||document.content.includes("\ufffd"))).toBe(false);
      expect(work.documents[2]?.content).toContain("\u7b2c\u4e8c\u7ae0\u7684\u540e\u534a\u90e8\u5206");
      expect(work.documents[1]?.relativePath).toContain("unknown.epub#part-1.html::v1-c1");
      expect(work.documents[2]?.sourceSegments?.map(segment=>segment.relativePath)).toEqual([
        "unknown.epub#part-1.html",
        "unknown.epub#part-2.html",
      ]);
      const store=new WritingStore(work);
      try{
        await store.index("rebuild");
        const explored=await store.explore("search","第二章的后半部分",10,0);
        expect(explored.results[0]?.evidence.locators?.map(locator=>locator.relativePath)).toEqual([
          "unknown.epub#part-1.html",
          "unknown.epub#part-2.html",
        ]);
      }finally{store.close();}
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  test("keeps document references unique when each EPUB is its own work (AUD-026)",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-multiple-")),data=await convertedBookFixture();await writeFile(join(dir,"one.epub"),data);await writeFile(join(dir,"two.epub"),data);const adapter=new GenericAdapter();
    try{const candidates=await adapter.discover(dir);expect(candidates).toHaveLength(2);for(const candidate of candidates){const work=await adapter.load(candidate);expect(new Set(work.documents.map(document=>document.documentRef)).size).toBe(work.documents.length);}}
    finally{await rm(dir,{recursive:true,force:true});}
  });

  test("rejects malformed packages without returning partial documents",async()=>{
    const cases:Array<[string,Buffer,string]>=[
      ["invalid ZIP",Buffer.from("not-a-zip"),"EPUB_INVALID_ZIP"],
      ["missing container",await fixtureZip({container:false,opf:true,chapters:true}),"EPUB_CONTAINER_MISSING"],
      ["missing OPF",await fixtureZip({container:true,opf:false,chapters:true}),"EPUB_OPF_MISSING"],
      ["missing spine documents",await fixtureZip({container:true,opf:true,chapters:false}),"EPUB_SPINE_RESOURCE_MISSING"]
    ];
    for(const [name,data,code] of cases){const dir=await mkdtemp(join(tmpdir(),"writing-mcp-epub-invalid-"));const path=join(dir,"invalid.epub");await writeFile(path,data);const adapter=new GenericAdapter();try{const [candidate]=await adapter.discover(path);await expect(adapter.load(candidate!),name).rejects.toMatchObject({code});}finally{await rm(dir,{recursive:true,force:true});}}
  });
});
