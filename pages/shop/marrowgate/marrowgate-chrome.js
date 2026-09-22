// Marrowgate "my store" choice, shared by every page's store strip. Online
// prices and ship-to-home stock are the same at every store; the choice decides
// where pickup orders wait and which hours the strip shows.
window.MARROWGATE_STORES = [
  { id: 'riverside', name: 'Riverside Commons', address: '1200 Ferrand Boulevard',
    closes: '9:00 pm', phone: '1-616-555-0151', note: 'Curbside pickup at door 4, order pickup counter inside door 2.' },
  { id: 'ottervane', name: 'Ottervane Plaza', address: '88 Corliss Avenue',
    closes: '8:00 pm', phone: '1-616-555-0152', note: 'Order pickup counter by the main entrance.' },
  { id: 'millpond', name: 'Millpond Crossing', address: '410 Delmar Parkway',
    closes: '9:00 pm', phone: '1-616-555-0153', note: 'Order pickup lockers in the lobby, open store hours.' },
  { id: 'eastfield', name: 'Eastfield Center', address: '26 Tolman Road',
    closes: '7:00 pm', phone: '1-616-555-0154',
    note: 'No monitor stock room: monitor pickups are sent over from Riverside Commons the next day.' },
];

window.marrowgateStore = function marrowgateStore() {
  let id = null;
  try {
    id = localStorage.getItem('marrowgate.store');
  } catch {
    id = null;
  }
  return window.MARROWGATE_STORES.find((s) => s.id === id) ?? window.MARROWGATE_STORES[0];
};

(() => {
  const strip = document.getElementById('mystore');
  const store = window.marrowgateStore();
  if (strip) strip.textContent = `Store: ${store.name} · Open until ${store.closes}`;
})();
