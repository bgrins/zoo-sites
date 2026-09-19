(function () {
  var page = location.pathname.split('/').pop() || 'index.html';
  var tabs = document.querySelectorAll('.tabs a[data-tab]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('href') === page) tabs[i].classList.add('on');
  }

  // The terminal session lives in this tab only, like the roster it loaded.
  var who = null;
  try { who = JSON.parse(sessionStorage.getItem('depot-operator')); } catch (e) {}
  var tab = document.querySelector('.tabs a.signout');
  if (tab && who && who.name) {
    tab.textContent = who.name + ' \u00b7 Sign out';
    tab.addEventListener('click', function (e) {
      e.preventDefault();
      sessionStorage.removeItem('depot-operator');
      sessionStorage.removeItem('depot-roster');
      location.href = 'index.html';
    });
  }
})();
