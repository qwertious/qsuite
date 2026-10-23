/*
 * zip.js -- a minimal, store-only ZIP writer.
 *
 * This exists so .docx export works with no external library. A .docx is just
 * a ZIP of a few XML parts, and the format permits entries stored uncompressed
 * (method 0), so the deflate half of a real ZIP library is unnecessary here.
 * The alternative was pulling JSZip from a CDN, which would have made qDocs
 * fail in exactly the situation it is designed for: no network.
 *
 * The files are a few kilobytes of XML, so storing them uncompressed costs
 * nothing worth having. Word, LibreOffice and Google Docs all open the result.
 *
 * Scope: no compression, no encryption, no ZIP64, no directory entries. If a
 * document ever exceeds 4 GB or 65535 parts, this is the wrong tool -- but a
 * text document will not.
 */
(function (global) {
  'use strict';

  // CRC-32 (IEEE 802.3), table built once on first use.
  let crcTable = null;

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    if (!crcTable) crcTable = makeCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // MS-DOS date/time, which is what ZIP stores. Two 16-bit fields, with
  // seconds halved and the year offset from 1980 -- an artefact of the format,
  // not a mistake.
  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function writer(size) {
    const buf = new Uint8Array(size);
    let pos = 0;
    return {
      bytes: buf,
      get length() { return pos; },
      u16(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; },
      u32(v) {
        buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF;
        buf[pos++] = (v >>> 16) & 0xFF; buf[pos++] = (v >>> 24) & 0xFF;
      },
      raw(src) { buf.set(src, pos); pos += src.length; },
    };
  }

  /**
   * Build a ZIP blob.
   * @param {Array<{name: string, data: string|Uint8Array}>} entries
   * @param {string} [mimeType] type for the returned Blob
   * @returns {Blob}
   */
  function create(entries, mimeType) {
    const enc = new TextEncoder();
    const now = dosDateTime(new Date());

    const prepared = entries.map((entry) => {
      const nameBytes = enc.encode(entry.name);
      const dataBytes = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
      return {
        nameBytes: nameBytes,
        dataBytes: dataBytes,
        crc: crc32(dataBytes),
        offset: 0,
      };
    });

    const LOCAL_HEADER = 30;
    const CENTRAL_HEADER = 46;
    const END_RECORD = 22;

    let localSize = 0;
    let centralSize = 0;
    for (const p of prepared) {
      localSize += LOCAL_HEADER + p.nameBytes.length + p.dataBytes.length;
      centralSize += CENTRAL_HEADER + p.nameBytes.length;
    }

    const out = writer(localSize + centralSize + END_RECORD);

    // Local file headers, each immediately followed by its data.
    for (const p of prepared) {
      p.offset = out.length;
      out.u32(0x04034b50);       // local file header signature
      out.u16(20);               // version needed (2.0)
      out.u16(0x0800);           // flags: bit 11 = names/comments are UTF-8
      out.u16(0);                // method 0 = stored
      out.u16(now.time);
      out.u16(now.date);
      out.u32(p.crc);
      out.u32(p.dataBytes.length); // compressed size == uncompressed, stored
      out.u32(p.dataBytes.length);
      out.u16(p.nameBytes.length);
      out.u16(0);                // extra field length
      out.raw(p.nameBytes);
      out.raw(p.dataBytes);
    }

    // Central directory: one record per entry, pointing back at its header.
    const centralStart = out.length;
    for (const p of prepared) {
      out.u32(0x02014b50);       // central directory header signature
      out.u16(20);               // version made by
      out.u16(20);               // version needed
      out.u16(0x0800);           // UTF-8 flag
      out.u16(0);                // stored
      out.u16(now.time);
      out.u16(now.date);
      out.u32(p.crc);
      out.u32(p.dataBytes.length);
      out.u32(p.dataBytes.length);
      out.u16(p.nameBytes.length);
      out.u16(0);                // extra
      out.u16(0);                // comment
      out.u16(0);                // disk number start
      out.u16(0);                // internal attributes
      out.u32(0);                // external attributes
      out.u32(p.offset);         // offset of local header
      out.raw(p.nameBytes);
    }

    // Central directory size must be measured BEFORE the end-of-central-
    // directory record is written, because writing it advances out.length --
    // reading out.length inline below would overstate the size by the 12 bytes
    // of EOCD header emitted so far, and readers would then scan past the end
    // of the archive ("bad magic number for central directory").
    const centralEnd = out.length;

    // End of central directory.
    out.u32(0x06054b50);
    out.u16(0);                  // this disk
    out.u16(0);                  // disk with central directory
    out.u16(prepared.length);    // entries on this disk
    out.u16(prepared.length);    // entries total
    out.u32(centralEnd - centralStart);
    out.u32(centralStart);
    out.u16(0);                  // comment length

    return new Blob([out.bytes.subarray(0, out.length)],
      { type: mimeType || 'application/zip' });
  }

  global.QZip = { create: create, crc32: crc32 };
})(window);
