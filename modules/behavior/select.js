import * as d3 from 'd3';
import _ from 'lodash';
import { modeBrowse, modeSelect } from '../modes/index';
import { osmEntity } from '../osm/index';


export function behaviorSelect(context) {

    function keydown() {
        if (d3.event && d3.event.shiftKey) {
            context.surface()
                .classed('behavior-multiselect', true);
        }
    }


    function keyup() {
        if (!d3.event || !d3.event.shiftKey) {
            context.surface()
                .classed('behavior-multiselect', false);
        }
    }


    function click() {
        var rtClick = d3.event.type === 'contextmenu';

        if (rtClick) {
          d3.event.preventDefault();
        }

        var datum = d3.event.target.__data__,
            lasso = d3.select('#surface .lasso').node(),
            mode = context.mode();

        if (datum.type === 'midpoint') {
            // do nothing
        } else if (!(datum instanceof osmEntity)) {
            if (!d3.event.shiftKey && !lasso && mode.id !== 'browse')
                context.enter(modeBrowse(context));

        } else if (!d3.event.shiftKey && !lasso) {
            // Reselect when 'rtClick on one of the selectedIDs'
            // OR 'leftClick on the same singular selected entity'
            // Explanation: leftClick should discard any multiple
            //  selection of entities and make the selection singlular.
            // Whereas rtClick should preserve multiple selection of
            // entities  if and only if it clicks on one of the selectedIDs.
            if (context.selectedIDs().indexOf(datum.id) >= 0 &&
                (rtClick || context.selectedIDs().length === 1)) {
                mode.suppressMenu(false).reselect();
            } else {
                context.enter(modeSelect(context, [datum.id]));
            }
        } else if (context.selectedIDs().indexOf(datum.id) >= 0) {
            if (rtClick) { // To prevent datum.id from being removed when rtClick
                mode.suppressMenu(false).reselect();
            } else {
                var selectedIDs = _.without(context.selectedIDs(), datum.id);
                context.enter(selectedIDs.length ? modeSelect(context, selectedIDs) : modeBrowse(context));
            }
        } else {
            context.enter(modeSelect(context, context.selectedIDs().concat([datum.id])));
        }
    }


    var behavior = function(selection) {
        d3.select(window)
            .on('keydown.select', keydown)
            .on('keyup.select', keyup);

        selection.on('click.select', click);
        selection.on('contextmenu.select', click);

        keydown();
    };


    behavior.off = function(selection) {
        d3.select(window)
            .on('keydown.select', null)
            .on('keyup.select', null);

        selection.on('click.select', null);

        keyup();
    };


    return behavior;
}
