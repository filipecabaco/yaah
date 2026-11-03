// Production React + the dev browser mock, so a production bundle can be timed in a plain browser.
import "./app.css";
import { installBrowserMock } from "@/dev/browser-mock";
installBrowserMock();
(window as unknown as { __perfMarks: Record<string, number> }).__perfMarks = { mockInstalled: performance.now() };
await import("@/main");
