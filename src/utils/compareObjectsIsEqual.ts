/**
 * 判断两个对象的 key 和 value 是否对应相等
 * @param obj1
 * @param obj2
 */
export function compareObjectsIsEqual(obj1: any = {}, obj2: any = {}) {
  const safeObj1 = obj1 && typeof obj1 === "object" ? obj1 : {};
  const safeObj2 = obj2 && typeof obj2 === "object" ? obj2 : {};
  const keys1 = Object.keys(safeObj1);
  const keys2 = Object.keys(safeObj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  for (let key of keys1) {
    if (safeObj1[key] !== safeObj2[key]) {
      return false;
    }
  }

  return true;
}
