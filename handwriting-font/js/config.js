/*
 * Shared configuration: the character set and the geometry of the printed
 * template. All template measurements are in millimetres on an A4 page.
 * Positions inside a cell are fractions of the cell's width / height.
 */
window.HW = window.HW || {};

(function (HW) {
  'use strict';

  const HEBREW = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת'.split('');
  const LATIN = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const DIGITS = '0123456789'.split('');
  const PUNCT = ['.', ',', '!', '?', '-', ':', ';', "'", '"', '(', ')', '/', '+', '=', '%', '@', '&'];

  HW.CHARS = HEBREW.concat(LATIN, DIGITS, PUNCT); // 80 characters = 8 x 10 grid

  const L = {
    pageW: 210,
    pageH: 297,
    cols: 8,
    rows: 10,
    gridX: 20,
    gridY: 38,
    gridW: 170,
    gridH: 236,
    markerSize: 9,      // solid black squares at the four grid corners
    markerOffset: 8,    // marker centre distance from the grid corner (on each axis)
    header: { x0: 40, x1: 170, y0: 9, y1: 23 }, // title band, used to detect orientation

    baseline: 0.68,                      // writing baseline inside a cell
    labelBox: { w: 0.24, h: 0.18 },      // small printed label in the top-left corner
    tick: 0.045,                         // length of the baseline ticks at cell edges
    crop: { x0: 0.07, x1: 0.93, y0: 0.045, y1: 0.955 } // area cut out of every cell
  };

  /** Marker centres in mm, ordered TL, TR, BR, BL. */
  L.markerCenters = function () {
    const o = L.markerOffset;
    const x0 = L.gridX - o, x1 = L.gridX + L.gridW + o;
    const y0 = L.gridY - o, y1 = L.gridY + L.gridH + o;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  };

  /** Grid corners in mm, ordered TL, TR, BR, BL. */
  L.gridCorners = function () {
    const x0 = L.gridX, x1 = L.gridX + L.gridW;
    const y0 = L.gridY, y1 = L.gridY + L.gridH;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  };

  HW.LAYOUT = L;

  HW.FINAL_FORMS = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
  HW.REGULAR_FORMS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

  HW.isHebrewLetter = (ch) => ch >= 'א' && ch <= 'ת';
  HW.isLatinOrDigit = (ch) => /[A-Za-z0-9]/.test(ch);
})(window.HW);
