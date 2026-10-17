/** Common, short, unambiguous nouns for passphrases. Every word counts as log2(WORDS.length) bits when picked uniformly. */
export const WORDS: readonly string[] = `
able acid acorn actor adapt agent alarm album alert alley amber anchor angle ankle apple april arch arena armor
arrow ash atlas atom attic aunt autumn avocado award badge bagel baker bamboo banjo barn basil basket beach beacon
beam bean beard bee beet bell belt bench berry bike bird biscuit blade blanket blaze bloom boat bolt bone book boots
bottle bowl box brain branch brave bread breeze brick bridge brook broom brush bubble bucket cabin cable cactus cake
camel camera candle candy canoe canyon cape captain carbon card carpet carrot castle cat cave cedar chain chair
chalk charm cheese cherry chess chief chimney cider cinema circle city clam clay cliff clock cloud clover coast
cobra cocoa coin comet compass copper coral cork corn cotton cove crab crane crayon creek crow crown crystal cube
cup curtain daisy dance dawn deer delta desert desk diamond dingo dish dock dolphin donkey door dove dragon drum
duck dune eagle earth echo eel egg elbow elder elm ember engine envelope falcon fan farm feather fern ferry fiddle
field fig finch fire fish flag flame flask flint flood flower flute fog forest fork fossil fox frame frost fruit
galaxy garden garlic gate gem ghost giant ginger glacier glass globe glove goat gold goose grape grass gravel grove
guitar gull hammer harbor hare harp hat hawk hazel heart hedge helmet hen heron hill hive honey hood hook horn horse
hotel house hut igloo iguana inch ink iris iron island ivory ivy jacket jade jaguar jam jar jelly jewel jungle
kayak kettle key kite kiwi knee knife knot koala lab ladder lake lamp lantern lark lava leaf lemon lens lentil lily
lime lion lizard llama lobster lock log lotus lunar lynx magnet mango maple marble market meadow melon mesa mint
mirror mist mole moon moss moth mouse mud mug mule mushroom nail needle nest net nettle night noodle north nut oak
oasis ocean olive onion opal orange orbit otter oven owl oyster paddle palm panda paper parrot pasta peach peanut
pear pearl pebble pencil penguin pepper piano pickle pie pigeon pillow pine pipe planet plum pocket pond poppy
potato prism pudding puffin pumpkin puzzle quail quartz quilt rabbit radish raft rain raven reed reef ribbon ridge
ring river robin rocket roof root rose ruby saddle saffron sage sail salmon salt sand satin scarf seal shadow shark
sheep shell shield ship shoe silk silver sky slate snail snow spark spider spoon spring spruce squid star stone
storm stream sugar summer sun swan sword table tea tent thistle thunder tiger timber toad tomato tower trail train
tree tulip tuna tunnel turtle umbrella valley vase velvet violet vine violin walnut wasp water wave whale wheat
willow wind window winter wolf wool wren yacht yak yarn yew zebra zinc
`
    .trim()
    .split(/\s+/);
