/**
 * The all-modes school-trips chart as published, numbers unchanged: five
 * modes by school year, Observable 10, y fixed at 0 to 160. One label
 * differs: the second series is named Driving here.
 */
const YEARS = Array.from({ length: 21 }, (_, i) => 2005 + i);
const N: Record<string, number[]> = {
  'Car passenger': [
    67, 53, 49, 58, 51, 61, 48, 52, 46, 55, 44, 45, 46, 68, 60, 38, 53, 54, 47, 48, 58,
  ],
  Driving: [22, 20, 22, 16, 13, 12, 10, 12, 9, 7, 12, 19, 18, 9, 9, 15, 18, 9, 13, 16, 16],
  Walking: [43, 47, 55, 52, 37, 38, 56, 46, 31, 43, 35, 38, 36, 34, 31, 12, 27, 31, 23, 31, 17],
  Biking: [12, 4, 5, 5, 6, 16, 14, 14, 14, 10, 9, 6, 7, 8, 10, 6, 6, 7, 8, 4, 18],
  'Other, mostly scooters': [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 3, 1, 3, 3, 6, 7, 8, 15, 8],
};

export const ALL_MODES_ORDER = [
  'Car passenger',
  'Driving',
  'Walking',
  'Biking',
  'Other, mostly scooters',
];

export const ALL_MODES = {
  data: {
    rows: YEARS.flatMap((year) =>
      ALL_MODES_ORDER.map((mode) => ({ year, mode, n: N[mode]?.[YEARS.indexOf(year)] ?? 0 })),
    ),
  },
  preset: {
    type: 'stackedArea',
    data: 'rows',
    x: 'year',
    y: 'n',
    series: 'mode',
    order: ['Car passenger', 'Driving', 'Walking', 'Biking', 'Other, mostly scooters'],
    format: { x: 'schoolYear', y: 'int' },
  },
  options: {
    height: 380,
    x: { ticks: [2005, 2010, 2015, 2020, 2025] },
    y: { domain: [0, 160] },
    color: {
      domain: ['Car passenger', 'Driving', 'Walking', 'Biking', 'Other, mostly scooters'],
      scheme: 'observable10',
    },
  },
};
