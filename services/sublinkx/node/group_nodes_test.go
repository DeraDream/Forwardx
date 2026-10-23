package node

import "testing"

func TestSelectedProxyNamesForGroupDefaultsToAll(t *testing.T) {
	all := []string{"po0-HKT", "po0-SG"}
	got := selectedProxyNamesForGroup("🚀 节点选择", all, nil)
	if len(got) != 2 || got[0] != "po0-HKT" || got[1] != "po0-SG" {
		t.Fatalf("selectedProxyNamesForGroup() = %#v, want all nodes", got)
	}
}

func TestSelectedProxyNamesForGroupIncludeFiltersToExistingNodes(t *testing.T) {
	all := []string{"po0-HKT", "po0-SG", "po0-US"}
	got := selectedProxyNamesForGroup("🇭🇰 香港节点", all, map[string]PolicyGroupNodeRule{
		"🇭🇰 香港节点": {
			Mode:  "include",
			Nodes: []string{"po0-HKT", "missing-node"},
		},
	})
	if len(got) != 1 || got[0] != "po0-HKT" {
		t.Fatalf("selectedProxyNamesForGroup() = %#v, want only po0-HKT", got)
	}
}

func TestSelectedProxyNamesForGroupNoneReturnsEmpty(t *testing.T) {
	got := selectedProxyNamesForGroup("🎯 全球直连", []string{"po0-HKT"}, map[string]PolicyGroupNodeRule{
		"🎯 全球直连": {Mode: "none"},
	})
	if len(got) != 0 {
		t.Fatalf("selectedProxyNamesForGroup() = %#v, want empty", got)
	}
}

func TestAppendUniqueNames(t *testing.T) {
	got := appendUniqueStringNames([]string{"DIRECT", "po0-HKT"}, []string{"po0-HKT", "po0-SG"})
	want := []string{"DIRECT", "po0-HKT", "po0-SG"}
	if len(got) != len(want) {
		t.Fatalf("appendUniqueStringNames() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("appendUniqueStringNames() = %#v, want %#v", got, want)
		}
	}
}

func TestPolicyGroupRulesForTemplateOnlyAppliesMatchingTemplate(t *testing.T) {
	rules := map[string]PolicyGroupNodeRule{
		"🚀 节点选择": {Mode: "none"},
	}
	config := SqlConfig{
		GroupNodes:         rules,
		GroupNodesTemplate: "./template/clash.yaml",
	}
	if got := policyGroupRulesForTemplate(config, "./template/clash.yaml"); len(got) != 1 {
		t.Fatalf("policyGroupRulesForTemplate() = %#v, want configured rules", got)
	}
	if got := policyGroupRulesForTemplate(config, "./template/surge.conf"); got != nil {
		t.Fatalf("policyGroupRulesForTemplate() = %#v, want nil for another template", got)
	}
}
