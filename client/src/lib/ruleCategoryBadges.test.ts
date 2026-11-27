import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ruleCategoryBadgeCacheKey, ruleCategoryBadgeQuery } from "./ruleCategoryBadges";

test("category badges stay global across selected tabs and their automatic resource filters", () => {
  const scope = { userId: 42 };
  const pageFilters = [
    { category: "local", resourceType: "local" },
    { category: "chain", resourceType: "chain" },
  ];
  for (const selected of pageFilters) {
    const badgeQuery = ruleCategoryBadgeQuery(scope, "HK");
    assert.deepEqual(badgeQuery, { userId: 42, page: 1, pageSize: 1, category: "all", search: "HK" });
    assert.notEqual(badgeQuery.category, selected.category);
    assert.ok(!("resourceType" in badgeQuery), "selected resource must not suppress other badges");
    assert.equal(ruleCategoryBadgeCacheKey("user-42", " HK "), ruleCategoryBadgeCacheKey("user-42", "HK"));
  }
  assert.deepEqual(ruleCategoryBadgeQuery({ scope: "all" }, ""), {
    scope: "all", page: 1, pageSize: 1, category: "all", search: "",
  });
});
