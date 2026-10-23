package node

import (
	"fmt"
	"testing"
)

func TestDecodeSSURL(t *testing.T) {
	type args struct {
		s string
	}
	tests := []struct {
		name    string
		args    args
		want    Ss
		wantErr bool
	}{
		{
			name: "ss",
			args: args{
				s: "ss://YWVzLTI1Ni1nY206NEhrdSt0Vk53SnFyblVZR2JycE95YkVhck03QmhxYmdhRTFxRk1JPQ==@127.0.0.1:34020?type=tcp#ocent-ss-ndptvd0p",
			},
		}, {
			name: "ss2",
			args: args{
				s: "ss://YWVzLTI1Ni1jZmI6S1NYTmhuWnBqd0M2UGM2Q0A1NC4xNjkuMzUuMjI4OjMxNDQ0",
			},
		}, {
			name: "no ss schema",
			args: args{
				s: "noss://YWVzLTI1Ni1jZmI6S1NYTmhuWnBqd0M2UGM2Q0A1NC4xNjkuMzUuMjI4OjMxNDQ0",
			},
			wantErr: true,
		}, {
			name: "sip002 url encoded auth",
			args: args{
				s: "ss://2022-blake3-aes-256-gcm%3Ab64%3Apassword@example.com:443#encoded-auth",
			},
			want: Ss{
				Param: Param{
					Cipher:   "2022-blake3-aes-256-gcm",
					Password: "b64:password",
				},
				Server: "example.com",
				Port:   443,
				Name:   "encoded-auth",
				Type:   "ss",
			},
		}, {
			name: "ss 2022 multi key client compatibility",
			args: args{
				s: "ss://2022-blake3-aes-256-gcm:gn9Z%2F6A0oX%2BmuUx2FPmecIfHLHJqlpmj7eALCa60QCk%3D:FO0NiZaoHp2f37hqclsmpbT6ExHGz%2FqoXhTNe6dr9t4%3D@42.193.170.239:46342?type=tcp#Po0",
			},
			want: Ss{
				Param: Param{
					Cipher:   "2022-blake3-aes-256-gcm",
					Password: "gn9Z/6A0oX+muUx2FPmecIfHLHJqlpmj7eALCa60QCk=:FO0NiZaoHp2f37hqclsmpbT6ExHGz/qoXhTNe6dr9t4=",
				},
				Server: "42.193.170.239",
				Port:   46342,
				Name:   "Po0",
				Type:   "ss",
			},
		}, {
			name: "invalid ss auth",
			args: args{
				s: "ss://not-base64-or-sip002@example.com:443#bad",
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DecodeSSURL(tt.args.s)
			if (err != nil) != tt.wantErr {
				t.Errorf("DecodeSSURL() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.want.Param.Cipher != "" && got != tt.want {
				t.Errorf("DecodeSSURL() = %#v, want %#v", got, tt.want)
			}
			if tt.name == "ss 2022 multi key client compatibility" {
				wantPassword := "FO0NiZaoHp2f37hqclsmpbT6ExHGz/qoXhTNe6dr9t4="
				if got.ClientPassword() != wantPassword {
					t.Errorf("ClientPassword() = %q, want %q", got.ClientPassword(), wantPassword)
				}
				encoded := EncodeSSURL(got)
				roundTrip, err := DecodeSSURL(encoded)
				if err != nil {
					t.Fatalf("DecodeSSURL(EncodeSSURL()) error = %v", err)
				}
				if roundTrip.Param.Password != wantPassword {
					t.Errorf("roundTrip password = %q, want %q", roundTrip.Param.Password, wantPassword)
				}
			}
			fmt.Println(got)
		})
	}
}
