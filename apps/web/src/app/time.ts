/** Clock time in the forms EPANET's files use. */

/** The current time as C's `ctime` prints it (local time), without the newline. */
export function ctime(d = new Date()): string {
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getMonth()
  ];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${day} ${mon} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}
