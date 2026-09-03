/* Разбор банковской выписки: из текстовых кусочков PDF - в строки операций.
 *
 * Здесь нет ни одного обращения к сети и к DOM: на вход приходят кусочки
 * текста с координатами (их достаёт pdf.js), на выходе - таблица операций.
 * Поэтому эту логику можно гонять на тестах отдельно от страницы.
 *
 * Главная мысль: не угадывать формат банка по названию, а опираться на то,
 * что видно в самом файле - где стоят числа по горизонтали и сходится ли
 * остаток. Если колонка «Остаток» найдена и по ней сходится арифметика,
 * значит колонки разобраны правильно. Это наша самопроверка.
 */
(function (root) {
  'use strict';

  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};

  // ---------- числа ----------
  // Банки пишут суммы по-разному: 1,234.56 | (123.45) | -123.45 | 123.45- |
  // 123.45 CR | $1,234.56 | £1,234.56. Возвращаем число или null.
  const CUR = '\\$£€₽¥₴₸';
  // Знак может стоять и спереди («+30 000.00» - так Т-Банк помечает
  // пополнения), и сзади, и скобками. Без плюса восемь операций Кирилла
  // просто выпадали из таблицы.
  const NUM_RE = new RegExp('^[' + CUR + ']?\\(?[-+]?[\\d,]+\\.\\d{2}\\)?-?(?:\\s?(?:CR|DR))?[' + CUR + ']?$', 'i');

  function parseAmount(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // валюта бывает и буквенным кодом: 1 250.00 RUB, 85.00 USD, 12.00 руб
    s = s.replace(/\s*(RUB|USD|EUR|GBP|CHF|PLN|KZT|UAH|TRY|AED|INR|CAD|AUD|руб\.?)\s*$/i, '');
    // отбрасываем валютные знаки и пробелы внутри
    s = s.replace(/[\s ]/g, '');
    if (!NUM_RE.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/DR$/i.test(s)) { neg = true; }
    if (/CR$/i.test(s)) { neg = false; }
    s = s.replace(/(CR|DR)$/i, '');
    if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    else if (s.startsWith('+')) { neg = false; s = s.slice(1); }
    s = s.replace(new RegExp('[' + CUR + ',]', 'g'), '');
    const v = parseFloat(s);
    if (!isFinite(v)) return null;
    return neg ? -v : v;
  }

  function looksLikeAmount(raw) { return parseAmount(raw) !== null; }

  // ---------- даты ----------
  // Возвращаем {y, m, d, ambiguous} либо null. ambiguous = не понятно,
  // 03/04 это 3 апреля или 4 марта; решаем потом по всему документу.
  function parseDate(raw, opts) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/[,]/g, ' ').replace(/\s+/g, ' ');
    let m;

    // 2026-09-02
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return {y: +m[1], m: +m[2], d: +m[3], ambiguous: false};

    // 02/09/2026 | 02-09-26 | 02.09.2026
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
    if (m) {
      const a = +m[1], b = +m[2];
      let year = m[3] ? +m[3] : (opts && opts.defaultYear) || null;
      if (year != null && year < 100) year += year < 70 ? 2000 : 1900;
      if (a > 12 && b <= 12) return {y: year, m: b, d: a, ambiguous: false, order: 'DM'};
      if (b > 12 && a <= 12) return {y: year, m: a, d: b, ambiguous: false, order: 'MD'};
      if (a > 12 && b > 12) return null;
      return {y: year, m: a, d: b, ambiguous: true, a: a, b: b};
    }

    // 02 Sep 2026 | 2 September | Sep 02 2026 | Sept 2
    m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.? ?(\d{2,4})?$/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (!mo) return null;
      let year = m[3] ? +m[3] : (opts && opts.defaultYear) || null;
      if (year != null && year < 100) year += 2000;
      return {y: year, m: mo, d: +m[1], ambiguous: false};
    }
    m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}) ?(\d{2,4})?$/);
    if (m) {
      const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (!mo) return null;
      let year = m[3] ? +m[3] : (opts && opts.defaultYear) || null;
      if (year != null && year < 100) year += 2000;
      return {y: year, m: mo, d: +m[2], ambiguous: false};
    }
    return null;
  }

  function fmtDate(d) {
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return (d.y ? d.y + '-' : '') + p(d.m) + '-' + p(d.d);
  }

  // ---------- строки ----------
  // pdf.js отдаёт разрозненные кусочки текста с координатами. Собираем их
  // в строки: всё, что стоит примерно на одной высоте - одна строка.
  function buildLines(items, tolerance) {
    const tol = tolerance || 2.2;
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      let row = null;
      for (const r of rows) {
        if (Math.abs(r.y - it.y) <= tol) { row = r; break; }
      }
      if (!row) { row = {y: it.y, items: []}; rows.push(row); }
      row.items.push(it);
      if (row.page === undefined) row.page = it.page || 0;
    }
    rows.sort((a, b) => b.y - a.y); // сверху вниз (в PDF ось Y снизу вверх)
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      // Склеиваем соседние кусочки, между которыми нет заметного зазора:
      // pdf.js часто рвёт одно слово или одно число на части.
      //
      // Отдельный случай - число с пробелом вместо запятой: «-2 940.00 ₽»
      // приезжает тремя кусочками с зазором около 2 пунктов. Для обычного
      // текста такой зазор - это пробел между словами, поэтому куски числа
      // склеиваем по более щедрому порогу, чем слова, и приклеиваем к числу
      // знак валюты.
      const isNumPart = s => /^[-+(]?[\d][\d.,]*$/.test(s) || /^[\d.,]+[)]?$/.test(s);
      const isCur = s => new RegExp('^[' + CUR + ']$').test(s.trim());
      const merged = [];
      for (const it of r.items) {
        const prev = merged[merged.length - 1];
        const gap = prev ? it.x - (prev.x + prev.w) : Infinity;
        const numGlue = prev && gap < 4.5 &&
          ((isNumPart(prev.str.trim()) && isNumPart(it.str.trim())) ||
           (isNumPart(prev.str.trim()) && isCur(it.str)));
        if (prev && (gap < 1.2 || numGlue)) {
          prev.str += (numGlue && isCur(it.str)) ? '' : it.str;
          prev.w = it.x + it.w - prev.x;
        } else {
          merged.push({str: it.str, x: it.x, w: it.w, y: it.y});
        }
      }
      r.cells = merged.filter(c => c.str.trim());
      r.text = r.cells.map(c => c.str).join(' ').replace(/\s+/g, ' ').trim();
    }
    return rows;
  }

  // ---------- служебные строки ----------
  // Шапки, итоги, «продолжение на следующей странице» - в таблицу не идут.
  const NOISE = /^(page \d|continued|statement period|account (number|summary)|opening balance|closing balance|balance (brought|carried) forward|total(s)?( |$)|beginning balance|ending balance|www\.|customer service|member fdic|important information|transaction detail|date\s+description|checking summary|deposits and additions|in case of errors|\*end\*)/i;

  function isNoise(text) { return NOISE.test(text.trim()); }

  // Хвост юридического текста и колонтитулов, который банки печатают прямо
  // под таблицей. В описание операции он попадать не должен: на настоящей
  // выписке Chase из-за него описание разрослось до 1640 символов.
  const TAIL_CUT = /(IN CASE OF ERRORS|\*end\*|nd\*transa|TRANSACTION DETAIL|CHECKING SUMMARY|Page \d+ of \d+|How to Read Your Statement|JPMorgan Chase Bank|Member FDIC|\(continued\)|universal license|Head of Back-office|Best regards)/i;

  function cleanDescription(text, dateStr) {
    let s = String(text || '').replace(/\s+/g, ' ').trim();
    const cut = s.search(TAIL_CUT);
    if (cut > 0) s = s.slice(0, cut).trim();
    // время операции банк печатает отдельной строчкой под датой; в описании
    // оно только мешает («15:12 15:18 Premium Kowloon»)
    s = s.replace(/(^|\s)\d{1,2}:\d{2}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    // когда описание стоит справа от сумм, первым в него попадает значок
    // валюты - он к описанию не относится
    s = s.replace(new RegExp('^[' + CUR + '\\s]+'), '').trim();
    // банк часто дублирует дату внутри описания: «02/01 Cvs/Pharmacy ...»
    s = s.replace(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-]\d{2,4})?\s+/, function (m, a, b) {
      if (!dateStr) return m;
      const p = dateStr.split('-');
      if (p.length !== 3) return m;
      const sameMD = (+a === +p[1] && +b === +p[2]);
      const sameDM = (+b === +p[1] && +a === +p[2]);
      return (sameMD || sameDM) ? '' : m;
    });
    if (s.length > 200) s = s.slice(0, 200).replace(/\s+\S*$/, '') + '…';
    return s.trim();
  }

  // ---------- разбор ----------
  // Каждая строка с датой в начале - начало новой операции. Строки без даты
  // считаем продолжением описания предыдущей (банки часто переносят текст).
  function parse(items, opts) {
    opts = opts || {};
    const lines = buildLines(items, opts.lineTolerance);

    // 1) год выписки: если в датах нет года, берём из шапки документа
    let defaultYear = opts.defaultYear || null;
    if (!defaultYear) {
      for (const l of lines.slice(0, 40)) {
        const m = l.text.match(/\b(20\d{2})\b/);
        if (m) { defaultYear = +m[1]; break; }
      }
    }

    // 2) находим строки-операции
    const raw = [];
    for (const line of lines) {
      if (!line.cells.length) continue;
      if (isNoise(line.text)) continue;
      // дату ищем в первых двух кусочках строки
      let date = null, dateCellIdx = -1;
      for (let i = 0; i < Math.min(2, line.cells.length); i++) {
        const cand = parseDate(line.cells[i].str, {defaultYear});
        // «10.50» - это сумма, а не дата: если рядом в строке есть суммы,
        // а этот кусочек похож и на дату и на сумму - считаем суммой
        if (cand && !(looksLikeAmount(line.cells[i].str) && /\./.test(line.cells[i].str))) {
          date = cand; dateCellIdx = i; break;
        }
      }
      const nums = line.cells
        .map((c, i) => ({i, x: c.x, w: c.w, right: c.x + c.w, v: parseAmount(c.str), str: c.str}))
        .filter(c => c.v !== null && c.i > dateCellIdx);

      if (date && nums.length) {
        raw.push({date, dateCellIdx, line, nums});
      } else if (raw.length && !date && line.cells.length && !nums.length) {
        // Строка без даты и без чисел - продолжение описания. Но одинокие
        // значки валюты, которые банк печатает чуть ниже суммы, описанием
        // не являются.
        const onlyCurrency = new RegExp('^[' + CUR + '\\s]+$').test(line.text);
        if (!onlyCurrency) {
          raw[raw.length - 1].tail = ((raw[raw.length - 1].tail || '') + ' ' + line.text).trim();
        }
      }
    }

    if (!raw.length) return {rows: [], warnings: ['No transaction rows were found in this file. It is most likely a scan rather than a text PDF. Open your online banking and download the statement as a PDF - that version carries the text this tool needs.'], dateOrder: null, columns: null};

    // 3) снимаем неоднозначность дат по всему документу:
    // если хоть где-то первое число больше 12 - формат день/месяц.
    // Пользователь может переопределить это вручную (opts.dateOrder).
    let order = opts.dateOrder || null;
    if (!order) { for (const r of raw) { if (r.date.order) { order = r.date.order; break; } } }
    if (!order) order = (opts.country === 'UK') ? 'DM' : 'MD';
    for (const r of raw) {
      if (r.date.ambiguous) {
        r.date = order === 'DM'
          ? {y: r.date.y, m: r.date.b, d: r.date.a, ambiguous: true}
          : {y: r.date.y, m: r.date.a, d: r.date.b, ambiguous: true};
      }
      if (!r.date.y && defaultYear) r.date.y = defaultYear;
    }

    // 4) колонки чисел: группируем по правому краю (числа выравнивают вправо).
    //
    // Важно: колонки считаем ОТДЕЛЬНО НА КАЖДОЙ СТРАНИЦЕ. На настоящей выписке
    // Chase правый край колонки «Сумма» гуляет между страницами на 20 пунктов -
    // если считать по всему документу, колонки разных страниц смешиваются,
    // и остаток попадает в суммы. Нумеруем колонки СПРАВА НАЛЕВО: нулевая -
    // самая правая. Тогда «остаток» на всех страницах имеет один и тот же
    // номер, даже если он сдвинут по горизонтали.
    const byPage = {};
    for (const r of raw) {
      const p = r.line.page || 0;
      (byPage[p] || (byPage[p] = [])).push(r);
    }
    // Числа в выписках выравнивают либо по правому краю (США, Британия),
    // либо по левому (так делает, например, Т-Банк). Пробуем оба варианта
    // и берём тот, где колонок получилось меньше: у верного выравнивания
    // числа собираются в аккуратные столбцы, у неверного - расползаются.
    function cluster(list, edge) {
      const cols = [];
      for (const r of list) {
        for (const n of r.nums) {
          const v = edge === 'right' ? n.right : n.x;
          let col = cols.find(c => Math.abs(c.pos - v) <= 8);
          if (!col) { col = {pos: v, count: 0}; cols.push(col); }
          col.pos = (col.pos * col.count + v) / (col.count + 1);
          col.count++;
        }
      }
      cols.sort((a, b) => b.pos - a.pos); // справа налево
      return cols;
    }

    let maxCols = 0;
    for (const p in byPage) {
      const list = byPage[p];
      const byRight = cluster(list, 'right');
      const byLeft = cluster(list, 'left');
      const edge = byLeft.length < byRight.length ? 'left' : 'right';
      const pageCols = edge === 'left' ? byLeft : byRight;
      for (const r of list) {
        for (const n of r.nums) {
          const v = edge === 'right' ? n.right : n.x;
          let best = 0, bestD = Infinity;
          pageCols.forEach((c, i) => {
            const d = Math.abs(c.pos - v);
            if (d < bestD) { bestD = d; best = i; }
          });
          n.col = best;
        }
      }
      maxCols = Math.max(maxCols, pageCols.length);
    }
    const cols = new Array(maxCols).fill(0).map((_, i) => ({index: i}));

    // 5) какая колонка - остаток? Та, где сходится арифметика:
    // остаток текущей строки = остаток предыдущей плюс/минус сумма операции.
    // Это же подтверждает, что колонки разобраны верно.
    // Сравниваем только соседние строки ВНУТРИ одной страницы: между
    // страницами порядок строк может рваться шапками и колонтитулами.
    const colIdx = cols.map((_, i) => i);
    let balanceCol = null, bestScore = 0, bestChecks = 0;
    // Проверок должно быть достаточно, иначе «сходимость» ничего не значит:
    // на настоящем Chase две случайные точки давали ложные 100%.
    const minChecks = Math.max(4, Math.round(raw.length * 0.25));
    for (const bi of colIdx) {
      let ok = 0, checks = 0;
      for (const p in byPage) {
        const list = byPage[p];
        const seq = list.map(r => { const n = r.nums.find(x => x.col === bi); return n ? n.v : null; });
        for (let i = 1; i < list.length; i++) {
          if (seq[i] == null || seq[i - 1] == null) continue;
          const amt = list[i].nums.filter(x => x.col !== bi).map(x => x.v);
          if (!amt.length) continue;
          checks++;
          const diff = +(seq[i] - seq[i - 1]).toFixed(2);
          if (amt.some(a => Math.abs(Math.abs(a) - Math.abs(diff)) < 0.005)) ok++;
        }
      }
      const score = checks >= minChecks ? ok / checks : 0;
      if (score > bestScore) { bestScore = score; balanceCol = bi; bestChecks = checks; }
    }
    if (bestScore < 0.6) { balanceCol = null; bestChecks = 0; } // не убедились - не выдумываем
    // Пользователь может указать колонку остатка сам: -1 значит «её нет»
    if (opts.balanceCol !== undefined && opts.balanceCol !== null) {
      balanceCol = opts.balanceCol < 0 ? null : opts.balanceCol;
      bestScore = 1;
    }

    // 6) остальные числовые колонки - это суммы.
    // Частый случай: отдельные колонки «списание» и «зачисление», причём
    // числа в них написаны без знака. Чтобы понять, какая колонка что
    // означает, учимся на строках, где остаток известен: смотрим, в какую
    // сторону он изменился, и запоминаем знак за колонкой. Потом применяем
    // выученное ко всем строкам - включая самую первую, где сравнивать
    // ещё не с чем.
    const amountCols = colIdx.filter(i => i !== balanceCol);
    const colSign = {};   // номер колонки -> {plus, minus}
    if (balanceCol != null) {
      for (const p in byPage) {
        let prev = null;
        for (const r of byPage[p]) {
          const balN = r.nums.find(n => n.col === balanceCol);
          const amts = r.nums.filter(n => n.col !== balanceCol);
          if (balN && prev != null) {
            const diff = +(balN.v - prev).toFixed(2);
            const hit = amts.find(a => Math.abs(Math.abs(a.v) - Math.abs(diff)) < 0.005);
            if (hit && diff !== 0) {
              const s = colSign[hit.col] || (colSign[hit.col] = {plus: 0, minus: 0});
              if (diff > 0) s.plus++; else s.minus++;
            }
          }
          if (balN) prev = balN.v;
        }
      }
    }
    // Колонка «знаковая», если банк сам пишет в ней минус или скобки.
    // Тогда выученный знак применять НЕЛЬЗЯ: число уже говорит правду,
    // а обобщение «в этой колонке обычно списания» испортит зачисления.
    // Именно на этом ломалась вторая страница двухстраничной выписки.
    const signedCol = {};
    for (const r of raw) {
      for (const n of r.nums) {
        if (n.v < 0 || /[()\-]/.test(n.str)) signedCol[n.col] = true;
      }
    }

    // Итоговый знак колонки: + зачисление, - списание, 0 - не поняли.
    // Если колонок сумм ровно две и мы ничего не выучили, действует обычай:
    // левая - списание, правая - зачисление.
    const signOf = {};
    for (const c of amountCols) {
      if (signedCol[c]) { signOf[c] = 0; continue; }
      const s = colSign[c];
      if (s && (s.plus + s.minus) >= 2) signOf[c] = s.plus > s.minus ? 1 : (s.minus > s.plus ? -1 : 0);
      else signOf[c] = 0;
    }
    if (amountCols.length === 2 && amountCols.every(c => signOf[c] === 0 && !signedCol[c])) {
      // колонки идут справа налево: 0 - правая (зачисление), 1 - левая (списание)
      const ordered = amountCols.slice().sort((a, b) => a - b);
      signOf[ordered[0]] = 1; signOf[ordered[1]] = -1;
    }

    const rows = [];
    let prevBalance = null, prevPage = null;
    for (const r of raw) {
      // на новой странице сравнивать не с чем: между страницами шапка
      if (prevPage !== null && (r.line.page || 0) !== prevPage) prevBalance = null;
      prevPage = r.line.page || 0;
      const balN = balanceCol == null ? null : r.nums.find(n => n.col === balanceCol);
      const amts = r.nums.filter(n => n.col !== balanceCol);
      let amount = null;
      if (amts.length === 1) {
        const a = amts[0];
        amount = a.v;
        // знак: изменение остатка надёжнее всего; если его нет - берём
        // знак, выученный за колонкой; если и его нет - оставляем как есть
        if (balN && prevBalance != null) {
          const diff = +(balN.v - prevBalance).toFixed(2);
          if (Math.abs(Math.abs(diff) - Math.abs(amount)) < 0.005) amount = diff;
          else if (signOf[a.col]) amount = signOf[a.col] * Math.abs(a.v);
        } else if (signOf[a.col]) {
          amount = signOf[a.col] * Math.abs(a.v);
        }
      } else if (amts.length > 1 &&
                 amts.every(a => Math.abs(Math.abs(a.v) - Math.abs(amts[0].v)) < 0.005)) {
        // Одна и та же сумма продублирована в нескольких колонках - так
        // делает Т-Банк: «сумма операции» и «сумма в валюте карты». Складывать
        // их нельзя, иначе платёж на 299 рублей превращается в 598.
        amount = signedCol[amts[0].col] ? amts[0].v
                                        : (signOf[amts[0].col] || 1) * Math.abs(amts[0].v);
        if (balN && prevBalance != null) {
          const diff = +(balN.v - prevBalance).toFixed(2);
          if (Math.abs(Math.abs(diff) - Math.abs(amount)) < 0.005) amount = diff;
        }
      } else if (amts.length > 1) {
        if (balN && prevBalance != null) {
          const diff = +(balN.v - prevBalance).toFixed(2);
          const cand = amts.find(a => Math.abs(Math.abs(a.v) - Math.abs(diff)) < 0.005);
          amount = cand ? diff : amts.reduce((acc, a) => acc + (signOf[a.col] || (a.v < 0 ? 1 : -1)) * Math.abs(a.v), 0);
        } else {
          amount = amts.reduce(function (acc, a) {
            // знаковую колонку берём как есть, беззнаковую - по выученному знаку
            return acc + (signedCol[a.col] ? a.v : (signOf[a.col] || 1) * Math.abs(a.v));
          }, 0);
        }
      }
      if (balN) prevBalance = balN.v;

      // описание - всё, что между датой и первым числом.
      // В выписках по картам часто две даты подряд (совершено / проведено) -
      // вторую в описание не тащим.
      const firstNumIdx = r.nums.length ? Math.min.apply(null, r.nums.map(n => n.i)) : r.line.cells.length;
      let descCells = r.line.cells.slice(r.dateCellIdx + 1, firstNumIdx);
      while (descCells.length && parseDate(descCells[0].str, {defaultYear})) descCells.shift();
      // Бывает, что описание стоит не между датой и суммами, а ПОСЛЕ них -
      // так устроена выписка Т-Банка. Если слева от чисел пусто, берём справа.
      if (!descCells.length && r.nums.length) {
        const lastNumIdx = Math.max.apply(null, r.nums.map(n => n.i));
        descCells = r.line.cells.slice(lastNumIdx + 1);
      }
      const desc = descCells.map(c => c.str).join(' ').replace(/\s+/g, ' ').trim();

      const dateStr = fmtDate(r.date);
      rows.push({
        date: dateStr,
        description: cleanDescription(desc + ' ' + (r.tail || ''), dateStr),
        amount: opts.invert && amount != null ? -amount : amount,
        balance: balN ? balN.v : null,
        _y: r.line.y
      });
    }

    // 7) предупреждения - честно говорим, чему не доверять
    const warnings = [];
    if (balanceCol == null) warnings.push('No running balance column was found, so the plus and minus signs are inferred from the column layout and may be wrong. Please spot-check a few rows.');
    else if (bestScore < 0.95) warnings.push('The balance adds up on ' + Math.round(bestScore * 100) + '% of rows, not all of them. Please check the table before downloading.');
    if (balanceCol != null) {
      const withBal = rows.filter(r => r.balance != null).length;
      if (withBal < rows.length * 0.6) {
        warnings.push('A balance was read on only ' + withBal + ' of ' + rows.length +
          ' rows - on the rest, the sign of the amount comes from the column layout.');
      }
    }
    if (rows.some(r => r.amount == null)) warnings.push('The amount could not be determined on some rows.');
    if (!defaultYear && rows.some(r => !/^\d{4}/.test(r.date))) warnings.push('This statement carries no year, so the dates show month and day only.');

    return {
      rows: rows,
      warnings: warnings,
      dateOrder: order,
      balanceConfidence: balanceCol == null ? 0 : bestScore,
      columns: {count: cols.length, balance: balanceCol, amounts: amountCols}
    };
  }

  // ---------- проверка итога ----------
  // Сумма всех операций должна равняться разнице первого и последнего остатка.
  function checkTotals(rows) {
    const withBal = rows.filter(r => r.balance != null);
    if (withBal.length < 2) return null;
    const first = withBal[0], last = withBal[withBal.length - 1];
    const idxFirst = rows.indexOf(first);
    const sum = rows.slice(idxFirst + 1).reduce((a, r) => a + (r.amount || 0), 0);
    const expected = +(last.balance - first.balance).toFixed(2);
    return {expected: expected, actual: +sum.toFixed(2), ok: Math.abs(expected - +sum.toFixed(2)) < 0.02};
  }

  const api = {parse, parseAmount, parseDate, buildLines, fmtDate, checkTotals};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StatementParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
