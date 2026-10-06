================================================
  DRONE COURIER: MARIN  —  what each file is
================================================

JUST WANT TO PLAY RIGHT NOW?
  Double-click  index.html
  That's the whole game. Works offline. Nothing else needed.


WANT IT ONLINE (so friends can play)?
  Upload these files to your GitHub repo, or drag this
  whole "pax" folder onto  app.netlify.com/drop


------------------------------------------------
THE FILES
------------------------------------------------

index.html      ⭐ THE GAME. This is the only file you
                truly need. Must keep this exact name —
                websites always look for "index.html".

404.html        A copy of the game. If someone types a
                wrong web address, they get the game
                instead of an error page.

_redirects      One line of text that tells Netlify:
                "any address → show the game." Stops
                "Page not found" errors for good.


------- optional: real online accounts -------

api.mjs         The account server. Handles sign-up,
                login, saving progress, the leaderboard,
                announcements, coin purchases, and the
                MISSION BOARD (pilots post missions, everyone
                can fly them). To hide a bad mission:
                /api/delmission?secret=YOURSECRET&code=MRN-XXXX
                WITHOUT this file the game still works —
                accounts just save in each player's own
                browser instead of online.

netlify.toml    Settings file. Tells Netlify where the
                website files are and where the server
                code lives.

package.json    Lists the one add-on the server needs
                (Netlify's storage system).


------- optional: extra web pages -------

guide.html        How to Play — controls and rules
fleet.html        The 5 drones and what they cost
leaderboard.html  Live ranking of every pilot
news.html         Your announcements + changelog
support.html      FAQ for players

These are linked from the bottom of the game screen.


------------------------------------------------
OWNER CHEAT SHEET  (only works once api.mjs is uploaded)
------------------------------------------------

First, in Netlify: Site configuration → Environment
variables → add  ADMIN_SECRET  = any password you pick.

Message every player:
  yoursite.netlify.app/api/setannounce?secret=YOURPASSWORD&msg=Hello+pilots
  (add  &clear=1  to remove it)

Make free coin codes:
  yoursite.netlify.app/api/gencode?secret=YOURPASSWORD&coins=500&n=5

================================================


------------------------------------------------
MISSION BUILDER  (new!)
------------------------------------------------

In the hangar, scroll to MISSION BUILDER. Set a name,
distance, cargo, birds, wind and dusk, then press
CREATE MISSION CODE.

You get a code like  MRN-3K9F

Send that code to anyone. They paste it into the
"Got a code?" box, press FLY IT, and they fly YOUR
mission — same distance, same weather, same hazards.

The game times every run and remembers your best.
Nastier conditions and heavier cargo pay more coins.
