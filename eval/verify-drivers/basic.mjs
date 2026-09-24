export const DRIVERS = {
  title: {
    note: 'reads the basic site title',
    async run({ goto, evaluate }) {
      await goto('/basic/title.html');
      return await evaluate(() => document.title);
    },
  },
};
