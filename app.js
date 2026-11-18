/* Control offline de catálogo, jornadas y reportes. */
const STORAGE_KEY = 'frutosecos_db';
const EMPTY_DB = () => ({ schemaVersion: 1, products: [], dailySales: [] });
const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const $ = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);
const todayISO = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };
const monthISO = () => todayISO().slice(0, 7);
const makeId = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `producto-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Storage: el primer acceso crea una base local vacía.
const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { const fresh = EMPTY_DB(); this.save(fresh); return fresh; }
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.products) && Array.isArray(parsed.dailySales)) return parsed;
      return EMPTY_DB();
    } catch (error) { console.error('No se pudo leer el almacenamiento local.', error); return EMPTY_DB(); }
  },
  save(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; }
    catch (error) { console.error('No se pudo guardar el almacenamiento local.', error); showToast('No se pudieron guardar los datos'); return false; }
  }
};

let db = Storage.load();
let activeTab = 'catalog';
let toastTimer;
let pendingQuantities = new Map();

const Products = {
  active() { return db.products.filter((product) => product.active); },
  add(name, price) {
    if (this.active().some((product) => product.name.trim().toLocaleLowerCase('es-CL') === name.trim().toLocaleLowerCase('es-CL'))) throw new Error('Ya existe un producto activo con ese nombre.');
    db.products.push({ id: makeId(), name: name.trim(), price, packageGrams: 80, active: true, createdAt: new Date().toISOString() });
    return Storage.save(db);
  },
  edit(id, name, price) {
    if (this.active().some((product) => product.id !== id && product.name.trim().toLocaleLowerCase('es-CL') === name.trim().toLocaleLowerCase('es-CL'))) throw new Error('Ya existe un producto activo con ese nombre.');
    const product = db.products.find((entry) => entry.id === id && entry.active);
    if (!product) throw new Error('No encontramos ese producto activo.');
    product.name = name.trim(); product.price = price;
    return Storage.save(db);
  },
  deactivate(id) {
    const product = db.products.find((entry) => entry.id === id && entry.active);
    if (!product) return false;
    product.active = false;
    return Storage.save(db);
  }
};

// Sales: cantidades en edición se reconstruyen a partir de la jornada guardada.
const Sales = {
  find(date) { return db.dailySales.find((sale) => sale.date === date); },
  loadDraft(date) {
    const sale = this.find(date);
    pendingQuantities = new Map();
    for (const product of Products.active()) {
      const saved = sale?.items.find((item) => item.productId === product.id);
      pendingQuantities.set(product.id, saved?.quantity || 0);
    }
    this.renderProducts(); this.renderTotals();
  },
  calculate(date) {
    const items = Products.active().map((product) => {
      const quantity = pendingQuantities.get(product.id) || 0;
      return { productId: product.id, productName: product.name, unitPrice: product.price, quantity, subtotal: product.price * quantity };
    }).filter((item) => item.quantity > 0);
    return { items, totalAmount: items.reduce((sum, item) => sum + item.subtotal, 0), totalPackages: items.reduce((sum, item) => sum + item.quantity, 0), date };
  },
  upsert(date) {
    const totals = this.calculate(date); const old = this.find(date);
    const sale = { id: old?.id || makeId(), date, ...totals, updatedAt: new Date().toISOString() };
    const index = db.dailySales.findIndex((entry) => entry.date === date);
    if (index >= 0) db.dailySales[index] = sale; else db.dailySales.push(sale);
    return Storage.save(db);
  },
  remove(date) { db.dailySales = db.dailySales.filter((sale) => sale.date !== date); return Storage.save(db); },
  renderProducts() {
    const list = byId('salesList'); list.replaceChildren();
    for (const product of Products.active()) {
      const card = document.createElement('article'); card.className = 'sales-product-card';
      const info = document.createElement('div'); info.className = 'product-info';
      const name = document.createElement('h3'); name.textContent = product.name;
      const price = document.createElement('span'); price.className = 'product-price'; price.textContent = `${CLP.format(product.price)} · 80 g`;
      const subtotal = document.createElement('p'); subtotal.className = 'muted item-subtotal'; subtotal.textContent = `Subtotal: ${CLP.format(product.price * (pendingQuantities.get(product.id) || 0))}`;
      info.append(name, price, subtotal);
      const controls = document.createElement('div'); controls.className = 'quantity-control';
      const minus = document.createElement('button'); minus.className = 'quantity-button'; minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', `Restar ${product.name}`);
      const input = document.createElement('input'); input.className = 'quantity-input'; input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; input.value = String(pendingQuantities.get(product.id) || 0); input.setAttribute('aria-label', `Cantidad de ${product.name}`);
      const plus = document.createElement('button'); plus.className = 'quantity-button'; plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', `Sumar ${product.name}`);
      const update = (value) => { const quantity = Number.isInteger(value) && value >= 0 ? value : 0; pendingQuantities.set(product.id, quantity); input.value = String(quantity); subtotal.textContent = `Subtotal: ${CLP.format(product.price * quantity)}`; this.renderTotals(); };
      minus.addEventListener('click', () => update((pendingQuantities.get(product.id) || 0) - 1)); plus.addEventListener('click', () => update((pendingQuantities.get(product.id) || 0) + 1));
      input.addEventListener('input', () => { if (input.value === '') { pendingQuantities.set(product.id, 0); subtotal.textContent = `Subtotal: ${CLP.format(0)}`; this.renderTotals(); return; } const value = Number(input.value); if (Number.isInteger(value) && value >= 0) update(value); });
      input.addEventListener('blur', () => { if (!input.value || !Number.isInteger(Number(input.value)) || Number(input.value) < 0) update(0); });
      controls.append(minus, input, plus); card.append(info, controls); list.append(card);
    }
    byId('salesEmpty').classList.toggle('hidden', Products.active().length > 0);
  },
  renderTotals() { const totals = this.calculate(byId('saleDate').value); byId('saleTotal').textContent = CLP.format(totals.totalAmount); byId('packageTotal').textContent = String(totals.totalPackages); byId('clearSaleButton').disabled = !this.find(byId('saleDate').value); }
};

// Reports: todos los valores se derivan de jornadas guardadas.
const Reports = {
  render(month) {
    const sales = db.dailySales.filter((sale) => sale.date.startsWith(month));
    const total = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);
    const packages = sales.reduce((sum, sale) => sum + sale.totalPackages, 0);
    byId('monthTotal').textContent = CLP.format(total); byId('monthPackages').textContent = String(packages); byId('monthDays').textContent = String(sales.length); byId('monthAverage').textContent = CLP.format(sales.length ? Math.round(total / sales.length) : 0);
    const products = new Map();
    for (const sale of sales) for (const item of sale.items) {
      const row = products.get(item.productId) || { name: item.productName, packages: 0, income: 0 };
      row.packages += item.quantity; row.income += item.subtotal; products.set(item.productId, row);
    }
    const ordered = [...products.values()].sort((a, b) => b.income - a.income);
    byId('productReport').replaceChildren(); byId('productReportEmpty').classList.toggle('hidden', ordered.length > 0);
    if (ordered.length) {
      const table = document.createElement('table'); const head = document.createElement('thead'); const headerRow = document.createElement('tr');
      for (const label of ['Producto', 'Paquetes', 'Ingresos']) { const th = document.createElement('th'); th.textContent = label; headerRow.append(th); }
      head.append(headerRow); const body = document.createElement('tbody');
      for (const item of ordered) { const row = document.createElement('tr'); for (const value of [item.name, String(item.packages), CLP.format(item.income)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } body.append(row); }
      table.append(head, body); byId('productReport').append(table);
    }
    const dayList = byId('dayReport'); dayList.replaceChildren(); const sorted = [...sales].sort((a, b) => b.date.localeCompare(a.date));
    byId('dayReportEmpty').classList.toggle('hidden', sorted.length > 0);
    for (const sale of sorted) { const row = document.createElement('button'); row.type = 'button'; row.className = 'day-row'; row.dataset.date = sale.date; const date = document.createElement('time'); date.dateTime = sale.date; date.textContent = formatDate(sale.date); const count = document.createElement('span'); count.className = 'day-packages'; count.textContent = `${sale.totalPackages} paquetes`; const amount = document.createElement('strong'); amount.textContent = CLP.format(sale.totalAmount); const arrow = document.createElement('span'); arrow.className = 'day-arrow'; arrow.textContent = '›'; row.append(date, count, amount, arrow); dayList.append(row); }
  }
};

function formatDate(iso) { return new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)); }
function showToast(message) { const toast = byId('toast'); toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }
function renderCatalog() {
  const list = byId('catalogList'); list.replaceChildren(); const active = Products.active(); byId('catalogPanel').classList.toggle('has-products', active.length > 0); byId('productCount').textContent = `${active.length} ${active.length === 1 ? 'activo' : 'activos'}`; byId('catalogEmpty').classList.toggle('hidden', active.length > 0);
  for (const product of active) {
    const card = document.createElement('article'); card.className = 'product-card'; const icon = document.createElement('span'); icon.className = 'product-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '🥜';
    const info = document.createElement('div'); info.className = 'product-info'; const name = document.createElement('h3'); name.textContent = product.name; const grams = document.createElement('p'); grams.textContent = `Paquete ${product.packageGrams} g`; info.append(name, grams);
    const price = document.createElement('strong'); price.className = 'product-price'; price.textContent = CLP.format(product.price);
    const actions = document.createElement('div'); actions.className = 'product-actions'; const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'small-action'; edit.textContent = 'Editar'; edit.addEventListener('click', () => openProductDialog(product)); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-action delete'; remove.textContent = 'Eliminar'; remove.addEventListener('click', () => { if (confirm(`¿Eliminar “${product.name}” del catálogo? El historial de ventas se conservará.`) && Products.deactivate(product.id)) { renderCatalog(); Sales.loadDraft(byId('saleDate').value); showToast('Producto eliminado del catálogo'); } });
    actions.append(edit, remove); card.append(icon, info, price, actions); list.append(card);
  }
}
function setTab(tab) {
  activeTab = tab; const panels = { catalog: 'catalogPanel', sales: 'salesPanel', summary: 'summaryPanel' };
  Object.entries(panels).forEach(([key, id]) => byId(id).classList.toggle('hidden', key !== tab));
  document.querySelectorAll('.nav-item').forEach((button) => { const selected = button.dataset.tab === tab; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (tab === 'sales') Sales.loadDraft(byId('saleDate').value); if (tab === 'summary') Reports.render(byId('reportMonth').value);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function openProductDialog(product = null) { byId('productForm').reset(); byId('productFormError').textContent = ''; byId('productId').value = product?.id || ''; byId('dialogTitle').textContent = product ? 'Editar producto' : 'Nuevo producto'; byId('productName').value = product?.name || ''; byId('productPrice').value = product?.price || ''; byId('productDialog').showModal(); setTimeout(() => byId('productName').focus(), 40); }

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.goto)));
document.querySelectorAll('.catalog-add-button').forEach((button) => button.addEventListener('click', () => openProductDialog()));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => byId('productDialog').close()));
byId('productForm').addEventListener('submit', (event) => {
  event.preventDefault(); const name = byId('productName').value.trim(); const price = Number(byId('productPrice').value); const id = byId('productId').value;
  if (!name) { byId('productFormError').textContent = 'Escribe el nombre del producto.'; return; }
  if (!Number.isInteger(price) || price <= 0) { byId('productFormError').textContent = 'El precio debe ser un número entero mayor que cero.'; return; }
  try { const saved = id ? Products.edit(id, name, price) : Products.add(name, price); if (saved) { byId('productDialog').close(); renderCatalog(); Sales.loadDraft(byId('saleDate').value); showToast(id ? 'Producto actualizado' : 'Producto agregado'); } }
  catch (error) { byId('productFormError').textContent = error.message; }
});
byId('saleDate').value = todayISO(); byId('reportMonth').value = monthISO(); byId('saleDate').addEventListener('change', () => { const sale = Sales.find(byId('saleDate').value); byId('saleDateHint').textContent = sale ? 'Jornada existente · los cambios reemplazarán este día al guardar.' : 'Nueva jornada para esta fecha.'; Sales.loadDraft(byId('saleDate').value); });
byId('saveSaleButton').addEventListener('click', () => { if (Sales.upsert(byId('saleDate').value)) { byId('saleDateHint').textContent = 'Jornada guardada.'; showToast('Jornada guardada'); } });
byId('clearSaleButton').addEventListener('click', () => { const date = byId('saleDate').value; if (!Sales.find(date)) return; if (confirm(`¿Borrar la jornada del ${formatDate(date)}? Esta acción no se puede deshacer.`) && Sales.remove(date)) { Sales.loadDraft(date); byId('saleDateHint').textContent = 'Jornada borrada.'; showToast('Jornada borrada'); } });
byId('reportMonth').addEventListener('change', () => Reports.render(byId('reportMonth').value));
byId('dayReport').addEventListener('click', (event) => { const row = event.target.closest('.day-row'); if (!row) return; byId('saleDate').value = row.dataset.date; byId('saleDate').dispatchEvent(new Event('change')); setTab('sales'); });
byId('exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `delicias_saludables_de_sharito_respaldo_${todayISO()}.json`; link.click(); URL.revokeObjectURL(url); document.querySelector('.more-menu').open = false; showToast('Respaldo descargado'); });
byId('importButton').addEventListener('click', () => { byId('importFile').click(); document.querySelector('.more-menu').open = false; });
byId('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (imported?.schemaVersion !== 1 || !Array.isArray(imported.products) || !Array.isArray(imported.dailySales)) throw new Error('El archivo no tiene una estructura válida.');
    const validProducts = imported.products.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Number.isInteger(p.price) && p.price > 0 && Number.isInteger(p.packageGrams) && typeof p.active === 'boolean' && typeof p.createdAt === 'string');
    const validSales = imported.dailySales.every((s) => s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Array.isArray(s.items) && Number.isInteger(s.totalAmount) && Number.isInteger(s.totalPackages) && typeof s.updatedAt === 'string' && s.items.every((i) => typeof i.productId === 'string' && typeof i.productName === 'string' && Number.isInteger(i.unitPrice) && Number.isInteger(i.quantity) && i.quantity > 0 && Number.isInteger(i.subtotal)));
    if (!validProducts || !validSales || new Set(imported.dailySales.map((sale) => sale.date)).size !== imported.dailySales.length) throw new Error('El archivo contiene datos incompletos o fechas duplicadas.');
    if (!confirm('Importar este respaldo reemplazará todos los datos guardados en este dispositivo. ¿Continuar?')) return;
    db = { schemaVersion: 1, products: imported.products, dailySales: imported.dailySales };
    if (Storage.save(db)) { renderCatalog(); Sales.loadDraft(byId('saleDate').value); Reports.render(byId('reportMonth').value); showToast('Respaldo importado'); }
  } catch (error) { alert(`No se pudo importar el respaldo: ${error.message}`); }
});

renderCatalog(); Sales.loadDraft(byId('saleDate').value); byId('saleDateHint').textContent = 'Nueva jornada para esta fecha.';
if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('No se pudo registrar el modo sin conexión.', error)));


