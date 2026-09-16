.data
message: .asciz "hello from rars\n"
.text
main:
  li a7, 4
  la a0, message
  ecall
  li a7, 10
  ecall
