type RuleBadgeScope = { userId?: number; scope?: "self" | "all" };

/** Tab badges represent all categories within the current user/search scope,
 * regardless of the selected tab or its automatically selected resource type. */
export function ruleCategoryBadgeQuery(scope: RuleBadgeScope | undefined, search: string) {
  return {
    ...(scope || {}),
    page: 1,
    pageSize: 1,
    category: "all" as const,
    search,
  };
}

export function ruleCategoryBadgeCacheKey(userScope: string, search: string) {
  return [userScope, search.trim() || "search-all"]
    .map((value) => encodeURIComponent(value))
    .join(".");
}
