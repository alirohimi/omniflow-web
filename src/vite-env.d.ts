/// <reference types="vite/client" />

// Tesseract worker types aren't shipped; declare the lazy module surface.
declare module 'tesseract.js';

// Vite `?worker` import (pdf.js worker) returns a Worker constructor.
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?worker' {
  const W: new () => Worker;
  export default W;
}
