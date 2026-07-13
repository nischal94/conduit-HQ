// HTML renderer for the §4.2 token demo. Task 4 replaces this stub with the
// full interactive page; the results-object shape is demo/token-demo.json's.
export function renderTokenDemoHtml(results) {
  return `<!doctype html><title>token demo</title><pre>${JSON.stringify(results, null, 2)}</pre>\n`;
}
