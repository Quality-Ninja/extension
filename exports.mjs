import { jsPDF } from 'jspdf';
import { zipSync } from 'fflate';
const text = value => new Blob([value], { type: 'text/plain;charset=utf-8' });
const quote = value => JSON.stringify(String(value || ''));
const robot = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t').replace(/ /g, '\\x20').replace(/([$@&%])\{/g, '\\$1{');
const csv = value => {
  let string = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(string)) string = "'" + string;
  return '"' + string.replace(/"/g, '""') + '"';
};
export function scripts(draft, steps) {
  const first = steps[0]?.url || 'about:blank';
  return {
    'script_playwright.py': `from playwright.sync_api import sync_playwright\n\ndef test_recording():\n    with sync_playwright() as p:\n        browser = p.chromium.launch()\n        page = browser.new_page()\n        page.goto(${quote(first)})\n${steps.map(s => `        page.locator(${quote('xpath=' + s.xpath)}).click()`).join('\n')}\n        browser.close()\n`,
    'script_selenium.py': `from selenium import webdriver\nfrom selenium.webdriver.common.by import By\nfrom selenium.webdriver.support.ui import WebDriverWait\nfrom selenium.webdriver.support import expected_conditions as EC\n\ndef test_recording():\n    driver = webdriver.Chrome()\n    try:\n        driver.get(${quote(first)})\n${steps.map(s => `        WebDriverWait(driver, 15).until(EC.element_to_be_clickable((By.XPATH, ${quote(s.xpath)}))).click()`).join('\n')}\n    finally:\n        driver.quit()\n`,
    'script_cypress.cy.js': `describe(${quote(draft.name)}, () => {\n  it('replays captured clicks', () => {\n    cy.visit(${quote(first)});\n${steps.map(s => `    cy.document().then(doc => {\n      const node = doc.evaluate(${quote(s.xpath)}, doc, null, 9, null).singleNodeValue;\n      expect(node, ${quote(s.label)}).to.exist;\n      cy.wrap(node).click();\n    });`).join('\n')}\n  });\n});\n`,
    'script_robot.robot': `*** Settings ***\nLibrary    SeleniumLibrary\nTest Teardown    Close All Browsers\n\n*** Test Cases ***\nRecorded workflow\n    Open Browser    ${robot(first)}    chrome\n${steps.map(s => `    Wait Until Element Is Visible    xpath=${robot(s.xpath)}    15s\n    Click Element    xpath=${robot(s.xpath)}`).join('\n')}\n`
  };
}
async function pdfReport(draft, steps) {
  // Canvas uses the browser's Unicode font fallback; no remote fonts or assets.
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754;
  const ctx = canvas.getContext('2d');
  let y = 65, pages = 0;
  function reset() { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#172433'; ctx.font = '23px sans-serif'; y = 65; }
  function flush() { if (pages++) pdf.addPage(); pdf.addImage(canvas.toDataURL('image/jpeg', .9), 'JPEG', 0, 0, 595.28, 841.89); reset(); }
  function line(value) {
    const chunks = String(value ?? '').split('\n');
    for (const chunk of chunks) {
      let row = '';
      for (const char of chunk) {
        if (ctx.measureText(row + char).width > 1100) { if (y > 1660) flush(); ctx.fillText(row, 65, y); y += 34; row = ''; }
        row += char;
      }
      if (y > 1660) flush(); ctx.fillText(row, 65, y); y += 34;
    }
  }
  reset(); line('QA Ninja — ' + draft.name); line(draft.createdAt); y += 20;
  for (const step of steps) {
    line(`Step ${step.sequence}: ${step.label}`); line(step.url); line(step.xpath);
    if (step.screenshot) {
      const bitmap = await createImageBitmap(step.screenshot);
      const width = 1050, height = Math.min(700, width * bitmap.height / bitmap.width);
      const actualWidth = height * bitmap.width / bitmap.height;
      if (y + height > 1660) flush();
      ctx.drawImage(bitmap, 65, y, actualWidth, height); y += height + 20; bitmap.close();
    } else { line('Screenshot unavailable for this step.'); }
    y += 25;
  }
  flush(); return pdf.output('blob');
}
export async function createExports(draft, steps) {
  const files = new Map();
  const serializable = steps.map(step => {
    const { screenshot, ...metadata } = step;
    const name = screenshot ? `screenshots/step-${String(step.sequence).padStart(5, '0')}.jpg` : null;
    if (screenshot) files.set(name, screenshot);
    return { ...metadata, screenshot: name };
  });
  files.set('recording.json', new Blob([JSON.stringify({ schema_version: 1, id: draft.id, name: draft.name, created_at: draft.createdAt, steps: serializable }, null, 2)], { type: 'application/json' }));
  const columns = ['sequence', 'timestamp', 'url', 'label', 'xpath', 'css_selector', 'aria_label', 'tabId', 'frameId', 'screenshot'];
  files.set('data.csv', new Blob(['\uFEFF' + [columns.map(csv).join(','), ...serializable.map(step => columns.map(key => csv(step[key])).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const introductions = { en: ['QA Ninja Documentation', 'Clicked'], es: ['Documentación QA Ninja', 'Clic en'], jp: ['QA Ninja ドキュメント', 'クリック'] };
  for (const [lang, [heading, clicked]] of Object.entries(introductions)) {
    files.set(`documentation_${lang}.txt`, text(`${heading}\n${draft.name}\n\n` + serializable.map(step => `${step.sequence}. ${clicked}: ${step.label}\n   URL: ${step.url}\n   XPath: ${step.xpath}\n   Screenshot: ${step.screenshot || 'unavailable'}\n   Frame: ${step.frameId || 0}`).join('\n\n')));
  }
  for (const [name, script] of Object.entries(scripts(draft, steps))) files.set(name, text(script));
  files.set('README.txt', text('QA Ninja click workflow exports\n\nScripts capture clicks, not typed values or video. Install the relevant framework before running. Review selectors and page state before replay. Iframe steps include frame metadata in recording.json; adapt scripts to enter those frames before replay. Missing screenshots are explicitly indicated in the report.\n'));
  files.set('report.pdf', await pdfReport(draft, steps));
  return files;
}
export async function writeFolder(parent, draft, files) {
  const name = `QaNinja-${draft.id}`;
  const directory = await parent.getDirectoryHandle(name, { create: true });
  // Retrying uses the same directory and filenames. COMPLETE.json is written last.
  await directory.removeEntry('COMPLETE.json').catch(error => { if (error.name !== 'NotFoundError') throw error; });
  for (const [relative, blob] of files) {
    const parts = relative.split('/'); let folder = directory;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
    const file = await folder.getFileHandle(parts.at(-1), { create: true });
    const stream = await file.createWritable();
    try { await stream.write(blob); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  }
  const marker = await directory.getFileHandle('COMPLETE.json', { create: true });
  const writer = await marker.createWritable();
  await writer.write(JSON.stringify({ recordingId: draft.id, files: [...files.keys()] })); await writer.close();
}
export async function downloadZip(draft, files) {
  const contents = {};
  for (const [name, blob] of files) contents[name] = new Uint8Array(await blob.arrayBuffer());
  const data = zipSync(contents, { level: 6 });
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `QaNinja-${draft.id}.zip`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
