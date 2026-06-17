#/usr/bin/bash

cd ~/RabbitEars TV
. env/bin/activate

python3 rabbitears_player.py 1>/dev/null 2>/dev/null & disown
python3 rabbitears/command_input.py 1>/dev/null 2>/dev/null & disown
