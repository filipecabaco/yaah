import { createCn } from "cn/config";

/**
 * clsx + tailwind-merge, knowing yaah's own `text-code` (index.css: the code size, Settings → Fonts)
 * is a font size, so it isn't dropped beside a text colour such as `text-destructive`.
 */
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: ["code"] }] } } });
