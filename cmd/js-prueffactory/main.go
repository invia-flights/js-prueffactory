// Command js-prueffactory checks a JavaScript project and reports the results.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/invia-flights/jscript-bench/internal/cli"
)

func main() {
	// The first SIGINT or SIGTERM cancels the Run, which cleans up and still
	// writes a Report. The second one skips the Report.
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	ctx, stop := cli.WithInterrupts(context.Background(), sigs)
	code := cli.Main(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
