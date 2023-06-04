//  计算版本号大小,转化大小
export function versionToNum(a: string) {
  let c = a.split(".");
  let num_place = ["", "0", "00", "000", "0000"],
    r = num_place.reverse();
  for (let i = 0; i < c.length; i++) {
    let len = c[i].length;
    c[i] = r[len] + c[i];
  }
  let res = c.join("");
  return res;
}
