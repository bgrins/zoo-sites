(function () {
  var page = location.pathname.split('/').pop() || 'index.html';
  var tabs = document.querySelectorAll('.tabs a[data-tab]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('href') === page) tabs[i].classList.add('on');
  }
})();
