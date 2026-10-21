/** Sequential predicates preserve input order and propagate database failures. */
export async function asyncFilter(items, predicate) {
  const result = []
  for (const [index, item] of items.entries()) if (await predicate(item, index, items)) result.push(item)
  return result
}
export async function asyncFind(items, predicate) {
  for (const [index, item] of items.entries()) if (await predicate(item, index, items)) return item
}
export async function asyncSome(items, predicate) {
  for (const [index, item] of items.entries()) if (await predicate(item, index, items)) return true
  return false
}
