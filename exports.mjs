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
// Secret fields get stable names (password_1, code_1, …) and typed values the recorder was told not to keep become
// inputs. Scripts read both from the environment, so no secret is ever written into a file.
export function prepareSteps(steps) {
  const secrets = new Map(), inputs = new Map();
  const slug = (label, fallback) => (String(label || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || fallback);
  const named = (map, key, label, fallback) => {
    if (!map.has(key)) {
      const base = slug(label, fallback).replace(/^(\d)/, 'v$1');
      let n = 1; while ([...map.values()].some(item => item.name === `${base}_${n}`)) n++;
      map.set(key, { name: `${base}_${n}`, label: String(label || fallback).slice(0, 80) });
    }
    return map.get(key).name;
  };
  const prepared = steps.map(step => {
    if (step.action_type !== 'fill') return step;
    if (step.sensitive) return { ...step, value: '', value_ref: { kind: 'secret', name: named(secrets, step.xpath, /pass/i.test(step.label) ? 'password' : step.label, 'secret') } };
    if (step.typed_hidden) return { ...step, value: '', value_ref: { kind: 'input', name: named(inputs, step.xpath, step.label, 'input') } };
    return step;
  });
  return { steps: prepared, secrets: [...secrets.values()].map(item => ({ ...item, kind: 'secret' })),
    inputs: [...inputs.values()].map(item => ({ ...item, default: '' })) };
}
const envName = name => 'QANINJA_' + name.toUpperCase();
function value(step, style) {
  const ref = step.value_ref;
  if (!ref) return style === 'robot' ? robot(step.value) : quote(step.value);
  const variable = envName(ref.name);
  return { py: `os.environ[${quote(variable)}]`, cy: `Cypress.env(${quote(variable)})`, robot: `%{${variable}}` }[style];
}
function playwright(step) {
  const target = `page.locator(${quote('xpath=' + step.xpath)})`;
  switch (step.action_type) {
    case 'fill': return `${target}.fill(${value(step, 'py')})`;
    case 'select': return `${target}.select_option(label=${quote(step.value)})`;
    case 'check': return `${target}.check()`;
    case 'uncheck': return `${target}.uncheck()`;
    case 'press': return `page.keyboard.press(${quote(step.key || 'Enter')})`;
    case 'navigate': return `page.goto(${quote(step.url)})`;
    default: return `${target}.click()`;
  }
}
function selenium(step) {
  const find = `WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.XPATH, ${quote(step.xpath)})))`;
  switch (step.action_type) {
    case 'fill': return `field = ${find}\n        field.clear()\n        field.send_keys(${value(step, 'py')})`;
    case 'select': return `Select(${find}).select_by_visible_text(${quote(step.value)})`;
    case 'check': case 'uncheck':
      return `box = ${find}\n        if box.is_selected() != ${step.action_type === 'check' ? 'True' : 'False'}:\n            box.click()`;
    case 'press': return `ActionChains(driver).send_keys(Keys.${(step.key || 'Enter').toUpperCase() === 'ENTER' ? 'ENTER' : 'RETURN'}).perform()`;
    case 'navigate': return `driver.get(${quote(step.url)})`;
    default: return `WebDriverWait(driver, 15).until(EC.element_to_be_clickable((By.XPATH, ${quote(step.xpath)}))).click()`;
  }
}
function cypress(step) {
  if (step.action_type === 'navigate') return `    cy.visit(${quote(step.url)});`;
  if (step.action_type === 'press') return `    cy.focused().type('{enter}');`;
  const action = {
    fill: `cy.wrap(node).clear().type(${value(step, 'cy')}${step.value_ref?.kind === 'secret' ? ', { log: false }' : ''});`,
    select: `cy.wrap(node).select(${quote(step.value)});`, check: 'cy.wrap(node).check();', uncheck: 'cy.wrap(node).uncheck();',
  }[step.action_type] || 'cy.wrap(node).click();';
  return `    cy.document().then(doc => {\n      const node = doc.evaluate(${quote(step.xpath)}, doc, null, 9, null).singleNodeValue;\n      expect(node, ${quote(step.label)}).to.exist;\n      ${action}\n    });`;
}
function robotStep(step) {
  const target = `xpath=${robot(step.xpath)}`;
  const wait = `    Wait Until Element Is Visible    ${target}    15s\n`;
  switch (step.action_type) {
    case 'fill': return wait + `    ${step.value_ref?.kind === 'secret' ? 'Input Password' : 'Input Text'}    ${target}    ${value(step, 'robot')}`;
    case 'select': return wait + `    Select From List By Label    ${target}    ${robot(step.value)}`;
    case 'check': return wait + `    Select Checkbox    ${target}`;
    case 'uncheck': return wait + `    Unselect Checkbox    ${target}`;
    case 'press': return '    Press Keys    None    RETURN';
    case 'navigate': return `    Go To    ${robot(step.url)}`;
    default: return wait + `    Click Element    ${target}`;
  }
}
export function scripts(draft, rawSteps) {
  const { steps } = prepareSteps(rawSteps);
  const first = steps[0]?.url || 'about:blank';
  const environment = steps.some(step => step.value_ref);
  const selects = steps.some(step => step.action_type === 'select'), keys = steps.some(step => step.action_type === 'press');
  return {
    'script_playwright.py': `${environment ? 'import os\n' : ''}from playwright.sync_api import sync_playwright\n\ndef test_recording():\n    with sync_playwright() as p:\n        browser = p.chromium.launch()\n        page = browser.new_page()\n        page.goto(${quote(first)})\n${steps.map(s => `        ${playwright(s)}`).join('\n')}\n        browser.close()\n`,
    'script_selenium.py': `${environment ? 'import os\n' : ''}from selenium import webdriver\nfrom selenium.webdriver.common.by import By\n${keys ? 'from selenium.webdriver.common.keys import Keys\nfrom selenium.webdriver.common.action_chains import ActionChains\n' : ''}${selects ? 'from selenium.webdriver.support.ui import Select\n' : ''}from selenium.webdriver.support.ui import WebDriverWait\nfrom selenium.webdriver.support import expected_conditions as EC\n\ndef test_recording():\n    driver = webdriver.Chrome()\n    try:\n        driver.get(${quote(first)})\n${steps.map(s => `        ${selenium(s)}`).join('\n')}\n    finally:\n        driver.quit()\n`,
    'script_cypress.cy.js': `describe(${quote(draft.name)}, () => {\n  it('replays the recorded workflow', () => {\n    cy.visit(${quote(first)});\n${steps.map(cypress).join('\n')}\n  });\n});\n`,
    'script_robot.robot': `*** Settings ***\nLibrary    SeleniumLibrary\nTest Teardown    Close All Browsers\n\n*** Test Cases ***\nRecorded workflow\n    Open Browser    ${robot(first)}    chrome\n${steps.map(robotStep).join('\n')}\n`
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
    line(`Step ${step.sequence}: ${describe(step, 'en')}`); line(step.url); if (step.xpath) line(step.xpath);
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
const VERBS = {
  en: { click: 'Clicked', fill: 'Typed into', select: 'Selected', check: 'Checked', uncheck: 'Unchecked', press: 'Pressed', navigate: 'Opened', secret: 'Typed a secret into' },
  es: { click: 'Clic en', fill: 'Escribió en', select: 'Seleccionó', check: 'Marcó', uncheck: 'Desmarcó', press: 'Presionó', navigate: 'Abrió', secret: 'Escribió un secreto en' },
  jp: { click: 'クリック', fill: '入力', select: '選択', check: 'チェック', uncheck: 'チェック解除', press: 'キー押下', navigate: '開く', secret: 'シークレットを入力' },
};
function describe(step, lang) {
  const verbs = VERBS[lang];
  if (step.action_type === 'press') return `${verbs.press}: ${step.key || 'Enter'}`;
  if (step.action_type === 'navigate') return `${verbs.navigate}: ${step.url}`;
  if (step.action_type === 'fill') {
    if (step.sensitive || step.value_ref?.kind === 'secret') return `${verbs.secret}: ${step.label}`;
    return `${verbs.fill}: ${step.label}${step.value ? ` = "${step.value}"` : ''}`;
  }
  if (step.action_type === 'select') return `${verbs.select}: ${step.label} = "${step.value}"`;
  return `${verbs[step.action_type] || verbs.click}: ${step.label}`;
}
export async function createExports(draft, steps) {
  const files = new Map();
  const prepared = prepareSteps(steps);
  const serializable = prepared.steps.map(step => {
    const { screenshot, typed_hidden, viewport, ...metadata } = step;
    const name = screenshot ? `screenshots/step-${String(step.sequence).padStart(5, '0')}.jpg` : null;
    if (screenshot) files.set(name, screenshot);
    return { ...metadata, screenshot: name };
  });
  const viewport = steps.find(step => step.viewport)?.viewport;
  const recording = { schema_version: 2, id: draft.id, name: draft.name, created_at: draft.createdAt,
    capture: { typed_values: draft.captureTyping !== false, extension_version: globalThis.chrome?.runtime?.getManifest?.().version || '' },
    start_url: serializable.find(step => step.url)?.url || '', ...(viewport && { viewport }),
    inputs: prepared.inputs, secrets: prepared.secrets, steps: serializable };
  files.set('recording.json', new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' }));
  const columns = ['sequence', 'timestamp', 'action_type', 'url', 'label', 'value', 'xpath', 'css_selector', 'aria_label', 'tabId', 'frameId', 'screenshot'];
  files.set('data.csv', new Blob(['\uFEFF' + [columns.map(csv).join(','), ...serializable.map(step => columns.map(key => csv(key === 'value' && step.value_ref ? `(${step.value_ref.kind}: ${step.value_ref.name})` : step[key])).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const headings = { en: 'QA Ninja Documentation', es: 'Documentación QA Ninja', jp: 'QA Ninja ドキュメント' };
  for (const [lang, heading] of Object.entries(headings)) {
    files.set(`documentation_${lang}.txt`, text(`${heading}\n${draft.name}\n\n` + serializable.map(step => `${step.sequence}. ${describe(step, lang)}\n   URL: ${step.url}\n   XPath: ${step.xpath || '-'}\n   Screenshot: ${step.screenshot || 'unavailable'}\n   Frame: ${step.frameId || 0}`).join('\n\n')));
  }
  for (const [name, script] of Object.entries(scripts(draft, steps))) files.set(name, text(script));
  const variables = [...prepared.secrets, ...prepared.inputs].map(item => `  ${envName(item.name)}  (${item.label})`);
  files.set('README.txt', text('QA Ninja workflow exports\n\nScripts replay clicks, typed text, selections, checkboxes, key presses and opened pages. Passwords, one-time codes and other secrets are never captured' +
    (variables.length ? `: set these environment variables before running a script:\n${variables.join('\n')}\n\n` : '.\n\n') +
    'Install the relevant framework before running. Review selectors and page state before replay. Iframe steps include frame metadata in recording.json; adapt scripts to enter those frames before replay. Missing screenshots are explicitly indicated in the report.\n'));
  files.set('report.pdf', await pdfReport(draft, prepared.steps));
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
