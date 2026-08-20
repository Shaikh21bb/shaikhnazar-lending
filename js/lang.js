(function () {
    const KEY = 'shaikh_lang';
    function getLang() {
        const v = localStorage.getItem(KEY);
        return v === 'kz' ? 'kk' : (v || 'ru');
    }
    window.__getLang = getLang;
    window.__t = function (ru, kk) {
        return getLang() === 'kk' ? (kk !== undefined ? kk : ru) : ru;
    };
})();