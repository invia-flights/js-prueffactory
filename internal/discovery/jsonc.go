package discovery

import "bytes"

// StripJSONC blanks comments, and optionally trailing commas, with spaces so
// that every byte offset and line keeps its place. A block comment that is not
// closed is left in place, so the JSON parser reports it.
func StripJSONC(data []byte, trailingCommas bool) []byte {
	out := append([]byte(nil), data...)
	blank := func(from, to int) {
		for i := from; i < to; i++ {
			if out[i] != '\n' && out[i] != '\r' {
				out[i] = ' '
			}
		}
	}
	for i := 0; i < len(out); {
		switch c := out[i]; {
		case c == '"':
			i++
			for i < len(out) && out[i] != '"' && out[i] != '\n' {
				if out[i] == '\\' {
					i++
				}
				i++
			}
			i++
		case c == '/' && i+1 < len(out) && out[i+1] == '/':
			end := i
			for end < len(out) && out[end] != '\n' {
				end++
			}
			blank(i, end)
			i = end
		case c == '/' && i+1 < len(out) && out[i+1] == '*':
			end := bytes.Index(out[i+2:], []byte("*/"))
			if end < 0 {
				return out
			}
			end += i + 4
			blank(i, end)
			i = end
		default:
			i++
		}
	}
	if !trailingCommas {
		return out
	}
	for i := 0; i < len(out); {
		switch out[i] {
		case '"':
			i++
			for i < len(out) && out[i] != '"' && out[i] != '\n' {
				if out[i] == '\\' {
					i++
				}
				i++
			}
			i++
		case ',':
			j := i + 1
			for j < len(out) && (out[j] == ' ' || out[j] == '\t' || out[j] == '\n' || out[j] == '\r') {
				j++
			}
			if j < len(out) && (out[j] == ']' || out[j] == '}') {
				out[i] = ' '
			}
			i++
		default:
			i++
		}
	}
	return out
}
