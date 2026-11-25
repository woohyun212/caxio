/** Compare complete member types, including readonly modifiers and nested callback arity. */
export type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type Assert<T extends true> = T;
