// Deterministic chapter-number parsing (AUD-027): extracted pure functions,
// behavior-frozen by tests/txt-numbering.test.ts.
const chineseDigits:Record<string,number>={"零":0,"〇":0,"○":0,"Ｏ":0,"０":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
// Supported chapter-number syntax (AUD-027): Arabic digits, Chinese numerals
// up to 九百九十九 (百 composition), and canonical roman numerals i..mmmcmxcix.
// Anything else is deterministically skipped, never guessed.
const tensOnes=(value:string):number|undefined=>{if(!value.includes("十"))return chineseDigits[value];const [tens,ones]=value.split("十"),t=tens?chineseDigits[tens]:1,o=ones?chineseDigits[ones]:0;if(t===undefined||o===undefined)return undefined;return t*10+o;};
export const chineseNumber=(value:string):number|undefined=>{if(/^\d+$/.test(value))return Number(value);const parts=value.split("百");if(parts.length===1)return tensOnes(value);if(parts.length!==2)return undefined;const hundredDigit=parts[0]?chineseDigits[parts[0]]:1;if(parts[0]&&hundredDigit===undefined)return undefined;const base=(hundredDigit??0)*100,rest=parts[1];if(!rest)return base;const below=rest.startsWith("零")?chineseDigits[rest.slice(1)]:tensOnes(rest);if(below===undefined||below<1||below>99)return undefined;return base+below;};
const romanUnit:Record<string,number>={i:1,v:5,x:10,l:50,c:100,d:500,m:1000};
export const romanNumber=(value:string):number|undefined=>{const v=value.toLowerCase();if(!/^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/.test(v))return undefined;let total=0,previous=0;for(let index=v.length-1;index>=0;index--){const digit=romanUnit[v[index]!]!;if(digit<previous)total-=digit;else total+=digit;previous=digit;}return total>=1?total:undefined;};
export const chapterNumber=(value:string)=>chineseNumber(value)??romanNumber(value);
export const chapterOf=(title:string)=>{const chinese=title.match(/第\s*([零〇○Ｏ０一二三四五六七八九十两百两\d]+)\s*(?:章|回|节)/)?.[1];if(chinese){const parsed=chapterNumber(chinese);if(parsed)return parsed;}const latin=title.match(/chapter\s+(\d+|[ivxlcdm]+)/i)?.[1];if(latin){const parsed=chapterNumber(latin);if(parsed)return parsed;}return Number(title.match(/(?:第\s*)?(\d+)\s*(?:章|chapter)?/i)?.[1])||undefined;};
