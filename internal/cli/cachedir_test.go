package cli

import "testing"

func TestCacheDirFollowsXDGCacheHomeThenHome(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"XDG_CACHE_HOME wins", map[string]string{"XDG_CACHE_HOME": "/x/cache", "HOME": "/home/me"}, "/x/cache/js-prueffactory"},
		{"HOME is the fallback", map[string]string{"HOME": "/home/me"}, "/home/me/.cache/js-prueffactory"},
		{"a relative XDG_CACHE_HOME is ignored, as the XDG spec says", map[string]string{"XDG_CACHE_HOME": "cache", "HOME": "/home/me"}, "/home/me/.cache/js-prueffactory"},
	}
	for _, c := range cases {
		if got := cacheDir(env(c.env)); got != c.want {
			t.Errorf("%s: cacheDir = %q, want %q", c.name, got, c.want)
		}
	}
}
