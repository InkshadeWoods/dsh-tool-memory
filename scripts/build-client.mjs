/**
 * client 半边构建：单文件、零依赖（React 由宿主模块表运行时 require），
 * 直接拷贝到 lib/。tsdown 的 clean 会先清空 lib，本脚本必须在 tsdown 之后跑。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "client", "index.js");
const outfile = join(root, "lib", "client.js");

mkdirSync(join(root, "lib"), { recursive: true });
copyFileSync(source, outfile);
console.log("client copied ->", outfile);
