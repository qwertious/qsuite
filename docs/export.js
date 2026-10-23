/*
 * export.js -- qDocs export. Everything runs in the browser; nothing is
 * uploaded anywhere, which is the point of qDocs being local-first.
 *
 *   .txt   the plain text
 *   .md    Markdown, walked from the document tree
 *   .html  one self-contained file, styles inlined, opens anywhere
 *   .pdf   via the print stylesheet and the browser's "Save as PDF"
 *   .docx  minimal OOXML, zipped by zip.js (no external library)
 *
 * All five walk the same DOM the editor produces, so a format is added by
 * writing one more walker rather than by teaching the editor a new model.
 */
(function (global) {
  'use strict';

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a timer, not immediately: Safari cancels an in-flight download
    // if the object URL disappears in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Strips characters Windows and macOS reject in filenames, so a document
  // titled "Q1: profit/loss" doesn't produce an unsaveable file.
  function safeFilename(title, extension) {
    const base = String(title || 'document')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'document';
    return base + '.' + extension;
  }

  function bodyToElement(html) {
    const el = document.createElement('div');
    el.innerHTML = html || '';
    return el;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // XML 1.0 forbids most control characters outright -- they cannot be escaped,
  // only removed, and leaving one in produces a .docx Word refuses to open.
  function escapeXml(s) {
    return String(s)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
      }[c]));
  }

  /* ------------------------------------------------------------ Markdown */

  function toMarkdown(html) {
    const root = bodyToElement(html);

    // Inline formatting, innermost first, so <strong><em>x</em></strong>
    // becomes ***x*** rather than losing a layer.
    function inline(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Escape only the markers that would change meaning mid-sentence.
        return node.textContent.replace(/([\\`*_[\]])/g, '\\$1');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const inner = Array.from(node.childNodes).map(inline).join('');
      switch (node.tagName) {
        case 'BR': return '  \n';
        case 'STRONG': case 'B': return inner.trim() ? '**' + inner + '**' : '';
        case 'EM': case 'I': return inner.trim() ? '*' + inner + '*' : '';
        case 'U': return inner.trim() ? '<u>' + inner + '</u>' : ''; // no Markdown equivalent
        case 'S': case 'STRIKE': case 'DEL': return inner.trim() ? '~~' + inner + '~~' : '';
        case 'CODE': return inner.trim() ? '`' + node.textContent + '`' : '';
        case 'A': {
          const href = node.getAttribute('href') || '';
          return href ? '[' + inner + '](' + href + ')' : inner;
        }
        default: return inner;
      }
    }

    const lines = [];

    function block(node, indent) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) lines.push(indent + text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      switch (node.tagName) {
        case 'H1': case 'H2': case 'H3':
        case 'H4': case 'H5': case 'H6': {
          const level = Number(node.tagName[1]);
          lines.push('', '#'.repeat(level) + ' ' + inline(node).trim(), '');
          return;
        }
        case 'UL': case 'OL': {
          let index = 1;
          Array.from(node.children).forEach((li) => {
            if (li.tagName !== 'LI') return;
            const marker = node.tagName === 'OL' ? (index++) + '. ' : '- ';
            // A nested list lives inside its <li>; take the item's own text
            // first, then recurse into the sublist one indent deeper.
            const own = Array.from(li.childNodes)
              .filter((n) => !(n.nodeType === Node.ELEMENT_NODE &&
                (n.tagName === 'UL' || n.tagName === 'OL')))
              .map(inline).join('').trim();
            lines.push(indent + marker + own);
            Array.from(li.children)
              .filter((n) => n.tagName === 'UL' || n.tagName === 'OL')
              .forEach((sub) => block(sub, indent + '  '));
          });
          lines.push('');
          return;
        }
        case 'BLOCKQUOTE':
          inline(node).split('\n').forEach((l) => lines.push('> ' + l.trim()));
          lines.push('');
          return;
        case 'PRE':
          lines.push('', '```', node.textContent.replace(/\n$/, ''), '```', '');
          return;
        case 'HR':
          lines.push('', '---', '');
          return;
        case 'P': case 'DIV': {
          const text = inline(node).trim();
          if (text) lines.push(indent + text, '');
          else if (node.tagName === 'P') lines.push('');
          return;
        }
        default: {
          if (node.children.length) {
            Array.from(node.childNodes).forEach((child) => block(child, indent));
          } else {
            const text = inline(node).trim();
            if (text) lines.push(indent + text);
          }
        }
      }
    }

    Array.from(root.childNodes).forEach((node) => block(node, ''));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* ------------------------------------------------- self-contained HTML */

  // The exported .html carries an invisible copy of the document as JSON, so
  // the file is BOTH a normal web page anyone can open AND something qDocs can
  // re-import without losing anything. Re-reading the rendered body instead
  // would lose the title, the timestamps, and any structure the browser
  // normalised on the way out -- a round trip through qDrive would quietly
  // degrade the document every time.
  const PAYLOAD_TYPE = 'application/qdocs+json';

  function embeddedPayload(doc) {
    const json = JSON.stringify({
      v: 1, title: doc.title, body: doc.body,
      created: doc.created, modified: doc.modified,
    });
    // '<' must be escaped or a document containing "</script>" in its text
    // would terminate the tag early and corrupt the page. < is still
    // valid JSON and parses back to '<'.
    return '<script type="' + PAYLOAD_TYPE + '">' +
      json.replace(/</g, '\\u003c') + '<\/script>';
  }

  // Recovers a document from a file produced by toStandaloneHtml. Falls back to
  // importing the visible body when the payload is missing, so an ordinary HTML
  // file from somewhere else still imports as something sensible.
  function parseQDocsHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const payload = doc.querySelector('script[type="' + PAYLOAD_TYPE + '"]');
    if (payload) {
      try {
        const data = JSON.parse(payload.textContent);
        if (data && typeof data.body === 'string') {
          return {
            title: data.title || 'Untitled document',
            body: data.body,
            created: data.created,
            modified: data.modified,
            lossless: true,
          };
        }
      } catch (e) {
        // fall through to the visible-content path below
      }
    }

    const heading = doc.querySelector('body > h1');
    const title = heading ? heading.textContent.trim() : (doc.title || 'Imported document');
    if (heading) heading.remove();
    const meta = doc.querySelector('.qdocs-meta');
    if (meta) meta.remove();
    return {
      title: title,
      body: doc.body ? doc.body.innerHTML.trim() : '',
      lossless: false,
    };
  }

  function toStandaloneHtml(doc) {
    // Deliberately self-contained: no stylesheet link, no external font, no
    // executable script. Double-clicking the file on a machine with no network
    // must render exactly as it does here.
    return '<!doctype html>\n<html lang="en">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escapeHtml(doc.title) + '</title>\n' +
      '<style>\n' +
      '  body { font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;\n' +
      '         line-height: 1.6; color: #1a1a1a; background: #fff;\n' +
      '         max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }\n' +
      '  h1, h2, h3 { line-height: 1.25; margin: 1.6em 0 0.5em; }\n' +
      '  h1 { font-size: 1.9rem; } h2 { font-size: 1.45rem; } h3 { font-size: 1.2rem; }\n' +
      '  p { margin: 0 0 1em; }\n' +
      '  ul, ol { margin: 0 0 1em 1.5em; }\n' +
      '  blockquote { margin: 0 0 1em; padding-left: 1em;\n' +
      '               border-left: 3px solid #ddd; color: #555; }\n' +
      '  code { font-family: Consolas, "Courier New", monospace;\n' +
      '         background: #f4f4f4; padding: 0.1em 0.35em; border-radius: 3px; }\n' +
      '  pre { background: #f4f4f4; padding: 1em; border-radius: 6px; overflow-x: auto; }\n' +
      '  pre code { background: none; padding: 0; }\n' +
      '  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }\n' +
      '  img { max-width: 100%; height: auto; }\n' +
      '  a { color: #a06a12; }\n' +
      '  .qdocs-meta { color: #888; font-size: 0.85rem; margin-bottom: 2.5rem;\n' +
      '                border-bottom: 1px solid #eee; padding-bottom: 1rem; }\n' +
      '  @media (prefers-color-scheme: dark) {\n' +
      '    body { background: #1a1a1a; color: #eee; }\n' +
      '    code, pre { background: #2a2a2a; }\n' +
      '    blockquote { border-left-color: #444; color: #aaa; }\n' +
      '    hr, .qdocs-meta { border-color: #333; }\n' +
      '    a { color: #ffc040; }\n' +
      '  }\n' +
      '</style>\n</head>\n<body>\n' +
      '<h1>' + escapeHtml(doc.title) + '</h1>\n' +
      '<div class="qdocs-meta">Exported from qDocs on ' +
      escapeHtml(new Date().toLocaleDateString()) + '</div>\n' +
      (doc.body || '') + '\n' +
      embeddedPayload(doc) + '\n</body>\n</html>\n';
  }

  /* ----------------------------------------------------------------- docx */

  const DOCX_CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  const DOCX_ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const DOCX_DOC_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // Only the styles the walker below can actually emit. Word falls back to
  // Normal for anything it doesn't recognise, so an incomplete stylesheet
  // degrades rather than breaks.
  const DOCX_STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
    ['Heading1:Heading 1:32', 'Heading2:Heading 2:26', 'Heading3:Heading 3:24']
      .map((spec) => {
        const [id, name, halfPt] = spec.split(':');
        return '<w:style w:type="paragraph" w:styleId="' + id + '">' +
          '<w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
          '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>' +
          '<w:rPr><w:b/><w:sz w:val="' + halfPt + '"/></w:rPr></w:style>';
      }).join('') +
    '<w:style w:type="paragraph" w:styleId="Quote">' +
    '<w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
    '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
    '</w:styles>';

  function toDocxXml(doc) {
    const root = bodyToElement(doc.body);
    const paragraphs = [];

    // One run: a contiguous piece of text plus the marks active over it.
    function run(text, marks) {
      if (!text) return '';
      const props = [];
      if (marks.bold) props.push('<w:b/>');
      if (marks.italic) props.push('<w:i/>');
      if (marks.underline) props.push('<w:u w:val="single"/>');
      if (marks.strike) props.push('<w:strike/>');
      if (marks.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      return '<w:r>' +
        (props.length ? '<w:rPr>' + props.join('') + '</w:rPr>' : '') +
        // xml:space="preserve" or Word silently eats leading/trailing spaces,
        // which turns "a **b** c" into "a**b**c".
        '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r>';
    }

    function runsFrom(node, marks) {
      if (node.nodeType === Node.TEXT_NODE) return run(node.textContent, marks);
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.tagName === 'BR') return '<w:r><w:br/></w:r>';

      const next = Object.assign({}, marks);
      if (node.tagName === 'STRONG' || node.tagName === 'B') next.bold = true;
      if (node.tagName === 'EM' || node.tagName === 'I') next.italic = true;
      if (node.tagName === 'U') next.underline = true;
      if (['S', 'STRIKE', 'DEL'].includes(node.tagName)) next.strike = true;
      if (node.tagName === 'CODE') next.code = true;

      return Array.from(node.childNodes).map((c) => runsFrom(c, next)).join('');
    }

    function paragraph(runsXml, styleId) {
      if (!runsXml) return;
      paragraphs.push('<w:p>' +
        (styleId ? '<w:pPr><w:pStyle w:val="' + styleId + '"/></w:pPr>' : '') +
        runsXml + '</w:p>');
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim()) paragraph(run(node.textContent, {}), null);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      switch (node.tagName) {
        case 'H1': paragraph(runsFrom(node, {}), 'Heading1'); return;
        case 'H2': paragraph(runsFrom(node, {}), 'Heading2'); return;
        case 'H3': case 'H4': case 'H5': case 'H6':
          paragraph(runsFrom(node, {}), 'Heading3'); return;
        case 'UL': case 'OL': {
          let index = 1;
          Array.from(node.children).forEach((li) => {
            if (li.tagName !== 'LI') return;
            // Real Word list numbering needs a numbering.xml part with abstract
            // definitions. A literal bullet/number prefix is a deliberate
            // simplification -- it reads correctly and keeps the package to
            // four parts. Nested lists recurse and pick up deeper indentation
            // from the ListParagraph style only, so they read as flat.
            const marker = node.tagName === 'OL' ? (index++) + '. ' : '• ';
            const own = Array.from(li.childNodes)
              .filter((n) => !(n.nodeType === Node.ELEMENT_NODE &&
                (n.tagName === 'UL' || n.tagName === 'OL')))
              .map((c) => runsFrom(c, {})).join('');
            paragraph(run(marker, {}) + own, 'ListParagraph');
            Array.from(li.children)
              .filter((n) => n.tagName === 'UL' || n.tagName === 'OL')
              .forEach(walk);
          });
          return;
        }
        case 'BLOCKQUOTE': paragraph(runsFrom(node, {}), 'Quote'); return;
        case 'PRE':
          node.textContent.split('\n').forEach((line) => {
            paragraph(run(line || ' ', { code: true }), null);
          });
          return;
        case 'HR': paragraph(run('———', {}), null); return;
        case 'P': case 'DIV': {
          const runs = runsFrom(node, {});
          if (runs) paragraph(runs, null);
          return;
        }
        default:
          if (node.children.length) Array.from(node.childNodes).forEach(walk);
          else paragraph(runsFrom(node, {}), null);
      }
    }

    paragraph(run(doc.title || 'Untitled document', {}), 'Heading1');
    Array.from(root.childNodes).forEach(walk);
    if (!paragraphs.length) paragraph(run('', {}), null);

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + paragraphs.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>' +
      '</w:sectPr></w:body></w:document>';
  }

  function toDocxBlob(doc) {
    if (!global.QZip) throw new Error('zip.js is required for .docx export');
    return global.QZip.create([
      // [Content_Types].xml must be first in the archive -- some readers,
      // including older Word, look for it at a fixed position.
      { name: '[Content_Types].xml', data: DOCX_CONTENT_TYPES },
      { name: '_rels/.rels', data: DOCX_ROOT_RELS },
      { name: 'word/_rels/document.xml.rels', data: DOCX_DOC_RELS },
      { name: 'word/styles.xml', data: DOCX_STYLES },
      { name: 'word/document.xml', data: toDocxXml(doc) },
    ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }

  /* ------------------------------------------------------------------ pdf */

  // Printing is how a browser makes a PDF. Rather than fight the page's own
  // layout, this opens a clean window containing the same standalone HTML and
  // prints that -- so the PDF matches the .html export exactly, and the app's
  // chrome can't leak into it.
  function printAsPdf(doc) {
    const win = global.open('', '_blank');
    if (!win) {
      throw new Error('Your browser blocked the print window. Allow pop-ups for this page and try again.');
    }
    win.document.write(toStandaloneHtml(doc));
    win.document.close();
    win.focus();
    // Wait for layout before printing, or the first page can come out blank.
    const go = () => setTimeout(() => { win.print(); }, 150);
    if (win.document.readyState === 'complete') go();
    else win.addEventListener('load', go);
  }

  /* -------------------------------------------------------------- public */

  const Export = {
    formats: [
      { id: 'txt', label: 'Plain text (.txt)' },
      { id: 'md', label: 'Markdown (.md)' },
      { id: 'html', label: 'Web page (.html)' },
      { id: 'docx', label: 'Word (.docx)' },
      { id: 'pdf', label: 'PDF (via print)' },
    ],

    run(doc, format) {
      switch (format) {
        case 'txt':
          download(new Blob([doc.plain || ''], { type: 'text/plain;charset=utf-8' }),
            safeFilename(doc.title, 'txt'));
          return;
        case 'md':
          download(new Blob([toMarkdown(doc.body)], { type: 'text/markdown;charset=utf-8' }),
            safeFilename(doc.title, 'md'));
          return;
        case 'html':
          download(new Blob([toStandaloneHtml(doc)], { type: 'text/html;charset=utf-8' }),
            safeFilename(doc.title, 'html'));
          return;
        case 'docx':
          download(toDocxBlob(doc), safeFilename(doc.title, 'docx'));
          return;
        case 'pdf':
          printAsPdf(doc);
          return;
        default:
          throw new Error('Unknown export format: ' + format);
      }
    },

    toMarkdown: toMarkdown,
    toStandaloneHtml: toStandaloneHtml,
    toDocxXml: toDocxXml,
    toDocxBlob: toDocxBlob,
    parseQDocsHtml: parseQDocsHtml,
    safeFilename: safeFilename,

    // Builds the same bytes `run()` would download, but as a Blob for callers
    // that want to put it somewhere other than the user's Downloads folder --
    // qDrive being the reason this exists.
    toBlob(doc, format) {
      switch (format) {
        case 'txt':
          return { blob: new Blob([doc.plain || ''], { type: 'text/plain;charset=utf-8' }),
            filename: safeFilename(doc.title, 'txt') };
        case 'md':
          return { blob: new Blob([toMarkdown(doc.body)], { type: 'text/markdown;charset=utf-8' }),
            filename: safeFilename(doc.title, 'md') };
        case 'html':
          return { blob: new Blob([toStandaloneHtml(doc)], { type: 'text/html;charset=utf-8' }),
            filename: safeFilename(doc.title, 'html') };
        case 'docx':
          return { blob: toDocxBlob(doc), filename: safeFilename(doc.title, 'docx') };
        default:
          throw new Error('Cannot save ".' + format + '" to qDrive');
      }
    },
  };

  global.QDocsExport = Export;
})(window);
