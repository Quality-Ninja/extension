/* Shared by the free inspector and the recorder. No page data leaves this module. */
(() => {
  const HTML = 'http://www.w3.org/1999/xhtml';
  const stable = ['id', 'data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'title', 'placeholder'];
  function literal(value) {
    value = String(value);
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `concat(${value.split("'").map(part => `'${part}'`).join(', "\'", ')})`;
  }
  function nodeTest(node) {
    return node.namespaceURI === HTML ? node.localName :
      `*[local-name()=${literal(node.localName)} and namespace-uri()=${literal(node.namespaceURI || '')}]`;
  }
  function supported(node) {
    return node?.nodeType === 1 && node.getRootNode() === node.ownerDocument;
  }
  function evaluate(expression, doc = document) {
    if (!expression.trim()) throw new Error('Enter an XPath to test.');
    const first = doc.evaluate(expression, doc, null, XPathResult.ANY_TYPE, null);
    if ([XPathResult.NUMBER_TYPE, XPathResult.STRING_TYPE, XPathResult.BOOLEAN_TYPE].includes(first.resultType)) {
      throw new Error('This XPath returns a value, not elements. Select an element path instead.');
    }
    const result = doc.evaluate(expression, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i);
      if (node.nodeType !== 1) throw new Error('This XPath returns non-element nodes. Select elements instead.');
      if (!node.closest('[data-qaninja-ui]')) nodes.push(node);
    }
    return nodes;
  }
  function unique(expression, node) {
    try {
      const result = evaluate(expression, node.ownerDocument);
      return result.length === 1 && result[0] === node;
    } catch { return false; }
  }
  function structural(node) {
    if (!supported(node)) throw new Error('Document XPath cannot traverse Shadow DOM. Select an element outside the shadow root.');
    const parts = [];
    for (let current = node; current; current = current.parentElement) {
      let position = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === current.localName && sibling.namespaceURI === current.namespaceURI) position++;
      }
      parts.unshift(`${nodeTest(current)}[${position}]`);
    }
    return '/' + parts.join('/');
  }
  function generate(node) {
    if (!supported(node) || !node.isConnected) throw new Error('The selected element is unavailable. Select an element again.');
    for (const attr of stable) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      const path = attr === 'id' ? `//*[@id=${literal(value)}]` : `//${nodeTest(node)}[@${attr}=${literal(value)}]`;
      if (unique(path, node)) return path;
    }
    const path = structural(node);
    if (!unique(path, node)) throw new Error('Unable to generate a unique XPath for this element.');
    return path;
  }
  globalThis.QaNinjaXPath = { literal, structural, generate, evaluate, unique, supported };
})();
