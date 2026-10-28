package discovery_test

import "testing"

// "The package uses Mocha" is decided over all suites of a chain, and also for
// a chain the tool refuses.

func TestUsesMochaHoldsAcrossTheSuitesOfAChain(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  bool
	}{
		{"mocha is only the second suite", map[string]string{
			"package.json": `{"scripts":{"test":"node --test a && mocha b"}}`}, true},
		{"mocha is behind an npm script", map[string]string{
			"package.json": `{"scripts":{"test":"npm run unit && npm run api","unit":"node --test","api":"mocha --config x.js"}}`}, true},
		{"only node:test suites", map[string]string{
			"package.json": `{"scripts":{"test":"node --test a && node --test b"}}`}, false},
		{"a refused chain with a mocha dependency", map[string]string{
			"package.json": `{"scripts":{"test":"npm run a || npm run b"},"devDependencies":{"mocha":"^10.0.0"}}`}, true},
		{"a refused chain without any sign of mocha", map[string]string{
			"package.json": `{"scripts":{"test":"npm run a || npm run b"}}`}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj := project(t, c.files)
			if got := proj.Packages[0].UsesMocha(); got != c.want {
				t.Errorf("UsesMocha = %v, want %v (tests %+v)", got, c.want, proj.Packages[0].Tests)
			}
		})
	}
}
