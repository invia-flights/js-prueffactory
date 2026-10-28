package resultset

import "reflect"

// fillNilSlices replaces every nil slice below v with an empty one, so the JSON
// has [] and never null where the schema wants an array.
func fillNilSlices(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			fillNilSlices(v.Elem())
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fillNilSlices(v.Field(i))
			}
		}
	case reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return // []byte content stays as it is
		}
		if v.IsNil() && v.CanSet() {
			v.Set(reflect.MakeSlice(v.Type(), 0, 0))
			return
		}
		for i := 0; i < v.Len(); i++ {
			fillNilSlices(v.Index(i))
		}
	}
}

// Normalize makes the set ready for JSON: nil slices become empty ones. Finalize
// calls it, and the writer calls it again in case something changed the set
// after that.
func (s *Set) Normalize() { fillNilSlices(reflect.ValueOf(s).Elem()) }
