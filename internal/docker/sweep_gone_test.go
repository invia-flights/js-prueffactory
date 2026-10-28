package docker

import (
	"errors"
	"testing"
)

func TestARemovalThatOnlyFindsTheResourceGoneCountsAsDone(t *testing.T) {
	gone := []string{
		"docker network rm failed (exit 1): Error response from daemon: network abc not found",
		"docker volume rm failed (exit 1): Error response from daemon: get abc: No such volume: abc",
		"docker rm failed (exit 1): Error response from daemon: No such container: abc",
	}
	for _, m := range gone {
		if !goneAlready(errors.New(m)) {
			t.Errorf("%q should count as already gone", m)
		}
	}
	real := []string{
		"docker network rm failed (exit 1): Error response from daemon: network abc has active endpoints",
		"docker volume rm failed (exit 1): Error response from daemon: remove abc: volume is in use",
	}
	for _, m := range real {
		if goneAlready(errors.New(m)) {
			t.Errorf("%q is a real failure", m)
		}
	}
}
