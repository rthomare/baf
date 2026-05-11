// Package qr prints a QR code to a writer for terminal display.
package qr

import (
	"io"

	"github.com/mdp/qrterminal/v3"
)

// Print writes a small, dense QR encoding s to w. Uses the half-block
// charset so the QR is half the height of the classic block variant —
// fits more comfortably in a typical terminal viewport.
func Print(w io.Writer, s string) {
	cfg := qrterminal.Config{
		Level:      qrterminal.L,
		Writer:     w,
		HalfBlocks: true,
		BlackChar:  qrterminal.BLACK_BLACK,
		WhiteBlackChar: qrterminal.WHITE_BLACK,
		WhiteChar:  qrterminal.WHITE_WHITE,
		BlackWhiteChar: qrterminal.BLACK_WHITE,
		QuietZone:  1,
	}
	qrterminal.GenerateWithConfig(s, cfg)
}
