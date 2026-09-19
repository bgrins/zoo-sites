// Pure helpers shared by site modules. Anything that needs request or session
// plumbing belongs on ctx instead (see README.md).

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
