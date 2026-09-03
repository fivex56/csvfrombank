/* Склейка страницы: взять файл у пользователя, вытащить текст через pdf.js,
 * отдать в разбор (js/parse.js), показать таблицу и дать скачать.
 *
 * Ни одной отправки наружу: файл читается через FileReader, библиотеки лежат
 * рядом в vendor/. Это и есть обещание продукта, поэтому никаких аналитик,
 * шрифтов со сторонних доменов и «безобидных» пингов тут быть не должно.
 */
(function () {
  'use strict';

  // Страницы под банки лежат в подпапке, поэтому путь к рабочему файлу
  // pdf.js берём относительно корня приложения.
  var BASE = window.APP_BASE || '';
  pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdf.worker.min.js';

  // Замок оплаты. Пока продукт в раннем доступе - выключен, всё бесплатно.
  // Когда появится приём денег (Polar или Stripe), ставим true и подключаем
  // проверку в canDownload().
  var PAYWALL = false;

  var el = function (id) { return document.getElementById(id); };
  var state = {items: null, name: '', pages: 0, result: null, opts: {}};

  // ---------- загрузка файла ----------
  function textItems(data) {
    return pdfjsLib.getDocument({data: data}).promise.then(function (pdf) {
      var all = [], chain = Promise.resolve();
      state.pages = pdf.numPages;
      var _loop = function (p) {
        chain = chain.then(function () {
          return pdf.getPage(p).then(function (page) {
            return page.getTextContent().then(function (tc) {
              // Страницы кладём одна под другой, чтобы строки разных страниц
              // не оказались на «одной высоте» и не склеились.
              var offset = (p - 1) * 5000;
              tc.items.forEach(function (it) {
                if (!it.str || !it.str.trim()) return;
                all.push({str: it.str, x: it.transform[4], y: it.transform[5] - offset,
                          w: it.width, h: it.height, page: p});
              });
            });
          });
        });
      };
      for (var p = 1; p <= pdf.numPages; p++) _loop(p);
      return chain.then(function () { return all; });
    });
  }

  function busy(msg) {
    var d = el('drop');
    if (dropHTML === null) dropHTML = d.innerHTML;
    d.innerHTML = '<div class="drop-inner"><div class="drop-icon" style="font-size:34px">⏳</div>' +
      '<div class="drop-title" style="font-size:19px;font-weight:650;margin-top:10px">' + msg + '</div>' +
      '<div class="drop-sub">reading the file on your computer</div></div>';
  }

  // Разметку зоны загрузки запоминаем при старте и возвращаем как была:
  // раньше она пересобиралась строкой в коде, и любая правка вёрстки
  // разъезжалась с тем, что видит человек после конвертации.
  var dropHTML = null;

  function resetDrop() {
    if (dropHTML !== null) el('drop').innerHTML = dropHTML;
    var pick = el('pick');
    if (pick) pick.onclick = function (e) { e.stopPropagation(); el('file').click(); };
  }

  function handleFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('pdf') === -1 && !/\.pdf$/i.test(file.name)) {
      alert('This looks like it is not a PDF. Download the PDF version of your statement from online banking.');
      return;
    }
    state.name = file.name.replace(/\.pdf$/i, '');
    busy('Reading ' + file.name);
    var fr = new FileReader();
    fr.onload = function () {
      textItems(new Uint8Array(fr.result)).then(function (items) {
        state.items = items;
        state.opts = {};
        run();
        resetDrop();
      }).catch(function (err) {
        resetDrop();
        alert('Could not open this PDF: ' + err.message);
      });
    };
    fr.readAsArrayBuffer(file);
  }

  function loadSample(url) {
    busy('Loading sample');
    fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      state.name = url.split('/').pop().replace(/\.pdf$/i, '') + '-sample';
      return textItems(new Uint8Array(buf));
    }).then(function (items) {
      state.items = items; state.opts = {}; run(); resetDrop();
    }).catch(function (e) { resetDrop(); alert('Sample failed to load: ' + e.message); });
  }

  // ---------- разбор и показ ----------
  function run() {
    if (!state.items) return;
    var res = StatementParser.parse(state.items, state.opts);
    state.result = res;
    render(res);
  }

  function money(v) {
    if (v == null) return '';
    return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  }

  function render(res) {
    var rows = res.rows;
    el('result').hidden = false;

    el('rtitle').textContent = rows.length ? rows.length + ' transactions found' : 'Nothing recognised';
    var span = '';
    if (rows.length) {
      var d1 = rows[0].date, d2 = rows[rows.length - 1].date;
      span = d1 + ' to ' + d2 + ' · ' + state.pages + ' page' + (state.pages > 1 ? 's' : '');
    }
    el('rmeta').textContent = span;

    // проверки: честно говорим, чему можно верить
    var checks = [];
    var totals = StatementParser.checkTotals(rows);
    if (totals) {
      checks.push(totals.ok
        ? {k: 'good', ic: '✓', t: 'Balance check passed - every amount adds up to the next balance, from ' + money(rows.find(function(r){return r.balance!=null;}).balance) + ' to ' + money(rows.filter(function(r){return r.balance!=null;}).pop().balance) + '.'}
        : {k: 'bad', ic: '!', t: 'Balance check failed - the amounts add up to ' + money(totals.actual) + ' but the balance moved by ' + money(totals.expected) + '. Check the rows below, or adjust the settings.'});
    }
    (res.warnings || []).forEach(function (w) {
      checks.push({k: rows.length ? 'warn' : 'bad', ic: '!', t: w});
    });
    el('checks').innerHTML = checks.map(function (c) {
      return '<div class="chk ' + c.k + '"><span class="ic">' + c.ic + '</span><span>' + c.t + '</span></div>';
    }).join('');

    // ручная подстройка
    var sel = el('optBalance');
    var cur = sel.value;
    var opts = ['<option value="">Detect automatically</option>', '<option value="-1">No balance column</option>'];
    for (var i = 0; i < (res.columns ? res.columns.count : 0); i++) {
      opts.push('<option value="' + i + '">Column ' + (i + 1) + ' from the left' +
        (res.columns.balance === i ? ' (detected)' : '') + '</option>');
    }
    sel.innerHTML = opts.join('');
    sel.value = cur;
    if (res.dateOrder && !el('optDate').value) el('optDate').selectedIndex = res.dateOrder === 'DM' ? 2 : 1;

    // таблица
    var head = '<thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance</th></tr></thead>';
    var body = rows.map(function (r) {
      var cls = r.amount == null ? '' : (r.amount < 0 ? 'neg' : 'pos');
      return '<tr><td class="date">' + r.date + '</td><td>' + escapeHtml(r.description) +
        '</td><td class="num ' + cls + '">' + money(r.amount) +
        '</td><td class="num">' + money(r.balance) + '</td></tr>';
    }).join('');
    var wrap = document.querySelector('.tablewrap');
    var actions = document.querySelector('.ractions');
    var ex = el('emptyExample');
    if (!rows.length) {
      // Пустая таблица с одними заголовками читается как поломка сайта.
      // Вместо неё показываем, как выглядит удачный разбор, и прячем
      // кнопки скачивания - качать всё равно нечего.
      if (wrap) wrap.hidden = true;
      if (actions) actions.hidden = true;
      if (ex) ex.hidden = false;
      el('tbl').innerHTML = '';
    } else {
      if (wrap) wrap.hidden = false;
      if (actions) actions.hidden = false;
      if (ex) ex.hidden = true;
      el('tbl').innerHTML = head + '<tbody>' + body + '</tbody>';
    }

    var sum = rows.reduce(function (a, r) { return a + (r.amount || 0); }, 0);
    var inflow = rows.filter(function (r) { return r.amount > 0; }).reduce(function (a, r) { return a + r.amount; }, 0);
    var outflow = rows.filter(function (r) { return r.amount < 0; }).reduce(function (a, r) { return a + r.amount; }, 0);
    el('rfoot').innerHTML = rows.length
      ? 'Money in <b>' + money(inflow) + '</b> · Money out <b>' + money(outflow) + '</b> · Net <b>' + money(sum) + '</b>'
      : '';

    el('result').scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[m];
    });
  }

  // ---------- выгрузка ----------
  function canDownload() {
    if (!PAYWALL) return true;
    return false; // здесь будет проверка оплаты
  }

  function tableData() {
    var rows = state.result ? state.result.rows : [];
    var out = [['Date', 'Description', 'Amount', 'Balance']];
    rows.forEach(function (r) {
      out.push([r.date, r.description, r.amount == null ? '' : r.amount, r.balance == null ? '' : r.balance]);
    });
    return out;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function downloadCsv() {
    if (!canDownload()) return;
    var data = tableData();
    var csv = data.map(function (row) {
      return row.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    // BOM - чтобы Excel не поломал буквы с диакритикой в описаниях
    saveBlob(new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'}), state.name + '.csv');
  }

  // QuickBooks Online и Xero принимают узкий формат: дата, описание, сумма.
  // Ни остатка, ни значков валюты. Это не придирка - файл с лишними
  // колонками там просто не примут, и человек уйдёт к конкуренту.
  function downloadQuickBooks() {
    if (!canDownload()) return;
    var rows = state.result ? state.result.rows : [];
    var out = [['Date', 'Description', 'Amount']];
    rows.forEach(function (r) {
      if (r.amount == null) return;
      var p = r.date.split('-');
      var d = p.length === 3 ? (p[1] + '/' + p[2] + '/' + p[0]) : r.date;
      out.push([d, r.description, r.amount]);
    });
    var csv = out.map(function (row) {
      return row.map(function (c) {
        var v = String(c == null ? '' : c);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
    saveBlob(new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'}),
             state.name + '-quickbooks.csv');
  }

  function downloadXlsx() {
    if (!canDownload()) return;
    var ws = XLSX.utils.aoa_to_sheet(tableData());
    ws['!cols'] = [{wch: 12}, {wch: 52}, {wch: 14}, {wch: 14}];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
    XLSX.writeFile(wb, state.name + '.xlsx');
  }

  // ---------- события ----------
  var drop = el('drop');
  drop.addEventListener('click', function () { el('file').click(); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  el('file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
  el('pick').onclick = function (e) { e.stopPropagation(); el('file').click(); };

  document.querySelectorAll('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () { loadSample(b.getAttribute('data-sample')); });
  });

  if (el('dlCsv')) el('dlCsv').onclick = downloadCsv;
  if (el('dlXlsx')) el('dlXlsx').onclick = downloadXlsx;
  if (el('dlQbo')) el('dlQbo').onclick = downloadQuickBooks;
  el('again').onclick = function () {
    el('result').hidden = true;
    state.items = null; state.result = null;
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  el('optDate').onchange = function () { state.opts.dateOrder = this.value || null; run(); };
  el('optBalance').onchange = function () {
    state.opts.balanceCol = this.value === '' ? null : parseInt(this.value, 10);
    run();
  };
  el('optInvert').onchange = function () { state.opts.invert = this.checked; run(); };

  // Тема: по умолчанию светлая - так привычнее тем, кто весь день в таблицах.
  // Выбор запоминается в самом браузере и никуда не отправляется.
  (function () {
    var btn = el('themeBtn');
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    function apply(t) {
      document.documentElement.setAttribute('data-theme', t);
      if (btn) btn.textContent = t === 'dark' ? '☀' : '☾';
    }
    apply(saved === 'dark' ? 'dark' : 'light');
    if (btn) btn.onclick = function () {
      var now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(now);
      try { localStorage.setItem('theme', now); } catch (e) {}
    };
  })();

  // Значок «работает офлайн» - показываем, что отсутствие сети ничего
  // не ломает. Это не украшение: это доказательство обещания.
  function net() {
    var t = el('netText');
    if (!t) return;   // на новом первом экране этого значка нет
    t.textContent = navigator.onLine
      ? 'Runs entirely in your browser'
      : 'You are offline - and it still works';
  }
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();
})();
