.data
value: .word 0
.text
main:
  li a0, 1
  addi a0, a0, 1
  li a7, 10
  ecall
